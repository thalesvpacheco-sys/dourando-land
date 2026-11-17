#!/usr/bin/env python3
"""
CAFIR (Receita Federal, dados abertos): baixa a edição mais recente e gera um CSV para a tabela cafir_imoveis.

    python3 scripts/baixar-cafir.py --uf GO SP --dest carga/cafir > carga/cafir/cafir.csv

A Receita publica uma pasta WebDAV com um arquivo de largura fixa por UF (UFs grandes vêm em partes: SP01, SP02...),
uma edição por mês (K34313UF.D61101.GO01.csv = edição 2026-11-01). A Receita só atende IPs do Brasil.
Saída (stdout): nirf;sncr;area_ha;nome;situacao;municipio;uf;data_inscricao;edicao — uma linha por imóvel.
Só biblioteca padrão. Não há dado pessoal nesses arquivos (nome do imóvel, não do titular).
"""
import argparse, csv, os, re, sys, time, urllib.request

BASE = 'https://arquivos.receitafederal.gov.br/public.php/dav/files/gn672Ad4CF8N6TK/Dados/Cadastros/CAFIR/'
HOST = 'https://arquivos.receitafederal.gov.br'
UA = {'User-Agent': 'Mozilla/5.0 (DouradoLand CAFIR)'}
# nirf, area (ha x10), código INCRA (SNCR), nome, situação, endereço, distrito, UF, município, CEP, data de inscrição, imune/isento, tipo
WIDTHS = [8, 9, 13, 55, 2, 56, 40, 2, 40, 8, 8, 3, 1]


def listar():
    body = b'<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:getcontentlength/></d:prop></d:propfind>'
    req = urllib.request.Request(BASE, data=body, method='PROPFIND', headers={**UA, 'Depth': '1', 'Content-Type': 'application/xml'})
    with urllib.request.urlopen(req, timeout=120) as r:
        xml = r.read().decode('utf-8', 'replace')
    out = []
    for href, size in re.findall(r'<d:href>([^<]+\.csv)</d:href>.*?<d:getcontentlength>(\d+)', xml, re.S):
        m = re.search(r'\.D(\d{5})\.([A-Z]{2})(\d{2})\.csv$', href)
        if m: out.append({'href': href, 'size': int(size), 'edicao': m.group(1), 'uf': m.group(2)})
    return out


def baixar(href, dest, size):
    """Download retomável (a Receita derruba conexões longas): continua do byte em que parou."""
    path = os.path.join(dest, href.rsplit('/', 1)[-1])
    for tentativa in range(8):
        have = os.path.getsize(path) if os.path.exists(path) else 0
        if have >= size: return path
        try:
            req = urllib.request.Request(HOST + href, headers={**UA, **({'Range': f'bytes={have}-'} if have else {})})
            with urllib.request.urlopen(req, timeout=180) as r, open(path, 'ab' if have else 'wb') as fh:
                while chunk := r.read(1 << 20): fh.write(chunk)
        except Exception as e:
            print(f'  {os.path.basename(path)}: {e}; tentando de novo em {10 * (tentativa + 1)} s', file=sys.stderr)
            time.sleep(10 * (tentativa + 1))
    raise RuntimeError(f'não consegui baixar {href}')


def linhas(path, edicao):
    starts = [sum(WIDTHS[:i]) for i in range(len(WIDTHS))]
    with open(path, encoding='latin-1', newline='') as fh:
        for line in fh:
            line = line.rstrip('\r\n').replace('\x00', ' ')
            if len(line) < 30: continue
            f = [line[s:s + w].strip() for s, w in zip(starts, WIDTHS)]
            nirf, area, sncr, nome, sit, _end, _dist, uf, mun, _cep, data = f[:11]
            if not nirf.isdigit(): continue
            sncr = sncr if sncr.isdigit() and int(sncr) > 0 else ''
            area_ha = f'{int(area) / 10:.1f}' if area.isdigit() else ''
            data = f'{data[:4]}-{data[4:6]}-{data[6:8]}' if len(data) == 8 and data.isdigit() else ''
            yield [nirf, sncr, area_ha, nome, sit, mun, uf, data, edicao]


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--uf', nargs='+', required=True, help='UFs, ou ALL')
    ap.add_argument('--dest', default='carga/cafir')
    a = ap.parse_args()
    os.makedirs(a.dest, exist_ok=True)
    files = listar()
    if not files: sys.exit('Pasta do CAFIR vazia ou inacessível')
    edicao = max(f['edicao'] for f in files)
    ufs = None if a.uf == ['ALL'] else {u.upper() for u in a.uf}
    alvo = [f for f in files if f['edicao'] == edicao and (ufs is None or f['uf'] in ufs)]
    # D61101 → 2026-11-01 (ano com um dígito depois de "202")
    data_ed = f'202{edicao[0]}-{edicao[1:3]}-{edicao[3:5]}'
    print(f'Edição {data_ed}: {len(alvo)} arquivos, {sum(f["size"] for f in alvo) / 1e6:.0f} MB', file=sys.stderr)
    w = csv.writer(sys.stdout, delimiter=';', lineterminator='\n')
    total = 0
    for f in alvo:
        path = baixar(f['href'], a.dest, f['size'])
        n = 0
        for row in linhas(path, data_ed):
            w.writerow(row); n += 1
        total += n
        os.remove(path)
        print(f'  {f["uf"]}: {os.path.basename(path)} — {n} imóveis', file=sys.stderr)
    print(f'Total: {total} imóveis', file=sys.stderr)
