#!/usr/bin/env python3
"""
Baixa bases territoriais de serviços oficiais (ArcGIS do IBAMA, WFS da FUNAI e do ICMBio/INDE) e grava um GeoJSON
por camada/UF em carga/, já com os campos no formato que o `territory:import` entende.

    python3 scripts/baixar-bases.py --uf GO DF --dest carga
    docker compose exec app npm run territory:import -- --layer sigef --uf GO --file /carga/sigef_GO.geojson --source "..."

Use `scripts/atualizar-bases.sh`, que faz as duas etapas e prefere a base oficial do INCRA quando ela está no ar.
Só biblioteca padrão do Python. Dados pessoais de autuados (nome, CPF/CNPJ) não são gravados.
"""
import argparse, datetime, gzip, json, os, ssl, sys, time, urllib.parse, urllib.request

UF_CODE = {'AC': 12, 'AL': 27, 'AP': 16, 'AM': 13, 'BA': 29, 'CE': 23, 'DF': 53, 'ES': 32, 'GO': 52, 'MA': 21, 'MT': 51, 'MS': 50, 'MG': 31, 'PA': 15,
           'PB': 25, 'PR': 41, 'PE': 26, 'PI': 22, 'RJ': 33, 'RN': 24, 'RS': 43, 'RO': 11, 'RR': 14, 'SC': 42, 'SP': 35, 'SE': 28, 'TO': 17}
IBAMA = 'https://pamgia.ibama.gov.br/server/rest/services/01_Publicacoes_Bases'
# O servidor da FUNAI não envia o certificado intermediário. Como fazem os navegadores, buscamos esse intermediário no
# endereço indicado no próprio certificado (AIA) e o somamos às autoridades do sistema: a verificação continua completa
# (cadeia até uma raiz confiável e nome do servidor), só deixa de faltar o elo que o servidor esqueceu de mandar.
INTERMEDIARIOS = {'geoserver.funai.gov.br': 'http://crt.sectigo.com/SectigoPublicServerAuthenticationCAOVR36.crt'}
_ctx = {}


def tls_context(host):
    if host not in _ctx:
        ctx = ssl.create_default_context()
        if host in INTERMEDIARIOS:
            with urllib.request.urlopen(INTERMEDIARIOS[host], timeout=60) as r:
                ctx.load_verify_locations(cadata=ssl.DER_cert_to_PEM_cert(r.read()))
        _ctx[host] = ctx
    return _ctx[host]


def get_json(url, tries=4):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0 (DouradoLand bases territoriais)'})
            with urllib.request.urlopen(req, timeout=180, context=tls_context(urllib.parse.urlsplit(url).hostname)) as r:
                body = r.read()
                # a API do IBGE responde comprimida mesmo sem o cliente pedir
                return json.loads(gzip.decompress(body) if body[:2] == bytes([0x1F, 0x8B]) else body)
        except Exception as e:  # rede instável em serviços públicos: tenta de novo
            if i == tries - 1: raise
            print(f'  tentativa {i + 1} falhou ({e}); repetindo…', file=sys.stderr); time.sleep(5 * (i + 1))


def arcgis(layer_url, where):
    """Todas as feições de uma camada ArcGIS FeatureServer, paginando de 2000 em 2000, em WGS 84."""
    out, offset = [], 0
    while True:
        q = urllib.parse.urlencode({'where': where, 'outFields': '*', 'outSR': 4326, 'f': 'geojson', 'resultOffset': offset,
                                    'resultRecordCount': 2000, 'orderByFields': 'objectid'})
        page = get_json(f'{layer_url}/query?{q}')
        if 'error' in page: raise RuntimeError(f"{layer_url}: {page['error']}")
        feats = page.get('features', [])
        out += feats; offset += len(feats)
        if len(feats) < 2000 and not page.get('properties', {}).get('exceededTransferLimit') and not page.get('exceededTransferLimit'): break
        if not feats: break
    return out


def wfs(base, type_name, cql):
    q = urllib.parse.urlencode({'service': 'WFS', 'version': '1.0.0', 'request': 'GetFeature', 'typeName': type_name, 'outputFormat': 'application/json',
                                'srsName': 'EPSG:4326', 'CQL_FILTER': cql})
    return get_json(f'{base}?{q}').get('features', [])


def ms_date(v):
    if isinstance(v, (int, float)) and v > 0: return datetime.datetime.fromtimestamp(v / 1000, datetime.timezone.utc).date().isoformat()
    return v or None


_muni = {}
def municipio(uf, code):
    """Nome do município a partir do código IBGE (o SIGEF traz só o código)."""
    if not isinstance(code, (int, float)): return code
    if uf not in _muni:
        try:
            _muni[uf] = {m['id']: m['nome'] for m in get_json(f'https://servicodados.ibge.gov.br/api/v1/localidades/estados/{UF_CODE[uf]}/municipios')}
        except Exception: _muni[uf] = {}
    return _muni[uf].get(int(code), str(int(code)))


def feat(f, **props):
    return {'type': 'Feature', 'geometry': f.get('geometry'), 'properties': {k: v for k, v in props.items() if v not in (None, '', ' ')}}


def sigef(uf):
    out = []
    for lid, svc, nat in [(9, 'lim_imovel_sigef_privado_a', 'Privado'), (10, 'lim_imovel_sigef_publico_a', 'Público')]:
        for f in arcgis(f'{IBAMA}/{svc}/FeatureServer/{lid}', f'uf_id={UF_CODE[uf]}'):
            p = f['properties']
            out.append(feat(f, codigo=p.get('parcela_co'), nome=p.get('nome_area'), municipio=municipio(uf, p.get('municipio_')),
                            situacao=' · '.join(dict.fromkeys(x for x in [p.get('status'), p.get('situacao_i')] if x)), matricula=p.get('registro_m'),
                            cns=p.get('registro_d'), data_referencia=ms_date(p.get('data_aprov')), codigo_imovel_sncr=p.get('codigo_imo'), natureza=nat))
    return out


def assentamento(uf):
    return [feat(f, codigo=p.get('cd_sipra'), nome=p.get('nome_proje'), municipio=p.get('municipio'), area_ha=_num(p.get('area_hecta')),
                 situacao=p.get('descricao_'), data_referencia=p.get('data_de_cr'), familias=p.get('num_famili'), superintendencia=p.get('sr'))
            for f in arcgis(f'{IBAMA}/assentamentos_incra/FeatureServer/1', f"uf = '{uf}'") for p in [f['properties']]]


def embargo(uf):
    out = []
    for f in arcgis(f'{IBAMA}/adm_embargos_ibama_a/FeatureServer/0', f"uf LIKE '%{uf}%'"):
        p = f['properties']
        out.append(feat(f, codigo=f"TAD {p.get('num_tad')}{p.get('serie_tad') or ''}".strip(), nome=p.get('nome_imovel'), municipio=p.get('municipio'),
                        situacao=p.get('sit_desmatamento'), data_referencia=ms_date(p.get('dat_embargo')), orgao='IBAMA', infracao=p.get('des_infracao'),
                        auto_infracao=p.get('num_auto_infracao'), processo=p.get('num_processo')))
    for f in arcgis(f'{IBAMA}/adm_embargo_icmbio_a/FeatureServer/0', f"uf LIKE '%{uf}%'"):
        p = f['properties']
        out.append(feat(f, codigo=f"AI {p.get('numero_ai')}{p.get('serie') or ''}".strip(), nome=p.get('nome_uc'), municipio=p.get('municipio'),
                        situacao=p.get('julgamento'), data_referencia=ms_date(p.get('data_auto')), orgao='ICMBio', infracao=p.get('tipo_infra'),
                        processo=p.get('nr_process')))
    return out


def uc(uf):
    out = [feat(f, codigo=p.get('cnuc'), nome=p.get('nomeuc'), area_ha=p.get('areahaalb'), situacao=p.get('categoria_'), esfera='Federal',
                grupo=p.get('grupouc'), data_referencia=p.get('criacaoano'))
           for f in wfs('https://geoservicos.inde.gov.br/geoserver/ICMBio/ows', 'ICMBio:limiteucsfederais_a', f"uf LIKE '%{uf}%'") for p in [f['properties']]]
    out += [feat(f, codigo=p.get('codigo'), nome=p.get('nome'), area_ha=p.get('area_ha') or None, situacao=p.get('categoria'), esfera='Estadual',
                 grupo=p.get('protecao'), orgao=p.get('orgao'), data_referencia=p.get('anocriacao') or None)
            for f in arcgis(f'{IBAMA}/lim_unidade_conservacao_est_a/FeatureServer/14', f"uf LIKE '%{uf}%'") for p in [f['properties']]]
    return out


def terra_indigena(uf):
    return [feat(f, codigo=p.get('terrai_codigo'), nome=p.get('terrai_nome'), municipio=p.get('municipio_nome'), area_ha=p.get('superficie_perimetro_ha'),
                 situacao=p.get('fase_ti'), etnia=p.get('etnia_nome'), modalidade=p.get('modalidade_ti'), data_referencia=p.get('data_atualizacao'))
            for f in wfs('https://geoserver.funai.gov.br/geoserver/Funai/ows', 'Funai:tis_poligonais', f"uf_sigla LIKE '%{uf}%'") for p in [f['properties']]]


def _num(v):
    try: return float(str(v).replace(',', '.'))
    except Exception: return None


LAYERS = {
    'sigef': (sigef, 'INCRA/SIGEF — cópia publicada pelo IBAMA (imóveis aprovados até abr/2022)'),
    'assentamento': (assentamento, 'INCRA — assentamentos, cópia publicada pelo IBAMA'),
    'embargo': (embargo, 'IBAMA e ICMBio — áreas embargadas'),
    'uc': (uc, 'ICMBio (federais) e SFB (estaduais) — unidades de conservação'),
    'terra_indigena': (terra_indigena, 'FUNAI — terras indígenas'),
}

if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--uf', nargs='+', required=True)
    ap.add_argument('--layer', nargs='+', default=list(LAYERS))
    ap.add_argument('--dest', default='carga')
    a = ap.parse_args()
    os.makedirs(a.dest, exist_ok=True)
    manifest = []
    for layer in a.layer:
        fn, source = LAYERS[layer]
        for uf in [u.upper() for u in a.uf]:
            try:
                feats = [f for f in fn(uf) if f.get('geometry')]
            except Exception as e:
                print(f'{layer}/{uf}: FALHA {e}', file=sys.stderr); continue
            path = os.path.join(a.dest, f'{layer}_{uf}.geojson')
            with open(path, 'w', encoding='utf-8') as fh: json.dump({'type': 'FeatureCollection', 'features': feats}, fh, ensure_ascii=False)
            print(f'{layer}/{uf}: {len(feats)} feições → {path}')
            if feats: manifest.append({'layer': layer, 'uf': uf, 'file': os.path.basename(path), 'source': source, 'count': len(feats)})
    with open(os.path.join(a.dest, 'bases.json'), 'w', encoding='utf-8') as fh: json.dump(manifest, fh, ensure_ascii=False, indent=1)
