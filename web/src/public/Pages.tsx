import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { api, track } from '../lib/api';
import { Field } from '../components/ui';
import { CENTRAL_WA } from './Layout';

function Page({ title, lede, children }: { title: string; lede?: string; children: ReactNode }) {
  useEffect(() => { document.title = `${title} — Dourado Land Intelligence`; }, [title]);
  return (
    <div className="page-narrow">
      <h1 className="page-title">{title}</h1>
      {lede && <p style={{ fontSize: 'var(--t1)', color: 'var(--ink-2)', maxWidth: '52ch', lineHeight: 1.45 }}>{lede}</p>}
      <div className="prose" style={{ marginTop: '2rem' }}>{children}</div>
    </div>
  );
}

function ContactForm({ kind, submitLabel, extra }: { kind: 'proprietario' | 'parceiro' | 'construtora' | 'contato'; submitLabel: string; extra?: ('creci' | 'city' | 'company')[] }) {
  const [f, setF] = useState<Record<string, any>>({ consent: false });
  const [state, setState] = useState<'idle' | 'busy' | 'done'>('idle');
  const [err, setErr] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr('');
    if (!f.consent) { setErr('Marque a autorização de contato para enviar.'); return; }
    setState('busy');
    try { await api('/api/public/contact', { body: { kind, ...f } }); track('generate_lead', { method: `form_${kind}` }); setState('done'); }
    catch (e: any) { setErr(e.message); setState('idle'); }
  };
  if (state === 'done') return <p className="notice ok">Recebido. A equipe Dourado responde em até um dia útil.</p>;
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  return (
    <form className="stack panel" onSubmit={submit} style={{ padding: '1.5rem', color: 'var(--ink)', fontSize: '1rem' }}>
      <div className="grid2">
        <Field label="Nome"><input required onChange={set('name')} autoComplete="name" /></Field>
        <Field label="Telefone com DDD"><input onChange={set('phone')} autoComplete="tel" inputMode="tel" /></Field>
        <Field label="E-mail"><input type="email" onChange={set('email')} autoComplete="email" /></Field>
        {extra?.includes('company') && <Field label="Empresa"><input onChange={set('company')} autoComplete="organization" /></Field>}
        {extra?.includes('creci') && <Field label="CRECI (se tiver)"><input onChange={set('creci')} /></Field>}
        {extra?.includes('city') && <Field label="Cidade da área"><input onChange={set('city')} /></Field>}
      </div>
      <Field label={kind === 'proprietario' ? 'Conte sobre a área (tamanho, localização, matrícula)' : 'Mensagem'}><textarea onChange={set('message')} /></Field>
      <label className="check"><input type="checkbox" checked={f.consent} onChange={(e) => setF({ ...f, consent: e.target.checked })} /><span>Autorizo a Dourado a usar estes dados para retornar o contato. <Link to="/privacidade">Como tratamos seus dados</Link>.</span></label>
      {err && <p className="error-text" role="alert">{err}</p>}
      <div><button className="btn" disabled={state === 'busy'}>{state === 'busy' ? 'Enviando…' : submitLabel}</button></div>
    </form>
  );
}

export function HowItWorks() {
  return (
    <Page title="Como funciona" lede="A Dourado capta, qualifica e intermedeia áreas para desenvolvimento imobiliário. A plataforma organiza cada etapa e registra quem fez o quê.">
      <ol className="steps-how" style={{ padding: 0, gridTemplateColumns: '1fr 1fr' }}>
        <li><h3>Captação</h3><p>A área entra com proprietário, matrícula e perímetro. Nada é publicado nessa fase.</p></li>
        <li><h3>Qualificação</h3><p>Zoneamento, infraestrutura e restrições recebem fonte, data de consulta e status: oficial, verificado ou declarado.</p></li>
        <li><h3>Autorização e publicação</h3><p>Com a autorização de divulgação do proprietário, um administrador revisa e publica. Preço, localização exata e proprietário podem ficar reservados.</p></li>
        <li><h3>Interesse</h3><p>Cada contato chega ao intermediador responsável pela área, com o código da oportunidade e a origem registrados.</p></li>
        <li><h3>Proposta</h3><p>Propostas e contrapropostas ficam versionadas, com aprovação interna antes do aceite.</p></li>
        <li><h3>Diligência e contrato</h3><p>Documentos e condições suspensivas acompanham a negociação até a conclusão.</p></li>
      </ol>
      <p style={{ marginTop: '2rem' }}><Link className="btn gold" to="/areas">Ver o banco de áreas</Link></p>
    </Page>
  );
}

export function Owners() {
  return (
    <Page title="Para proprietários" lede="Se você tem uma gleba ou terreno com potencial de desenvolvimento, a Dourado avalia, qualifica e apresenta a área a construtoras e incorporadoras compatíveis.">
      <p>Você decide o que pode ser divulgado. A localização exata, o valor e seus dados podem ficar visíveis apenas para a equipe e para interessados qualificados.</p>
      <p>Depois do cadastro, você acompanha o andamento e envia documentos pelo seu acesso.</p>
      <ContactForm kind="proprietario" submitLabel="Enviar área para avaliação" extra={['city']} />
    </Page>
  );
}

export function Builders() {
  return (
    <Page title="Para construtoras e investidores" lede="Informe onde e o que você quer construir. O sistema cruza seu perfil com o banco de áreas e explica, critério a critério, por que uma área encaixa.">
      <p>O perfil de aquisição considera cidades, faixa de metragem, tipologia, orçamento, modelo de permuta, estágio mínimo de aprovação e restrições técnicas. Áreas com dados não verificados aparecem com essa ressalva.</p>
      <p>Empresas parceiras também acessam a vitrine exclusiva, com áreas que não são exibidas publicamente.</p>
      <ContactForm kind="construtora" submitLabel="Solicitar acesso de parceiro" extra={['company']} />
    </Page>
  );
}

export function Partners() {
  return (
    <Page title="Seja um parceiro" lede="Corretores e intermediadores podem trabalhar áreas da carteira Dourado ou trazer novas captações.">
      <p>Cada oportunidade tem um intermediador responsável. Comissões seguem o contrato de intermediação de cada área e só se tornam devidas nos eventos previstos em contrato.</p>
      <ContactForm kind="parceiro" submitLabel="Quero ser parceiro" extra={['creci', 'company']} />
    </Page>
  );
}

export function About() {
  return (
    <Page title="Sobre a Dourado" lede="A Dourado Real Estate Partners conecta proprietários de terra a quem desenvolve empreendimentos.">
      <p className="notice">Texto institucional provisório. Substituir pelo conteúdo oficial da Dourado Real Estate Partners.</p>
      <p>A plataforma Dourado Land Intelligence opera sobre a tecnologia WingsBr, que fornece identidade, CRM e mensageria.</p>
    </Page>
  );
}

export function Contact() {
  return (
    <Page title="Contato" lede="Fale com a equipe Dourado sobre uma área específica, uma parceria ou o seu perfil de aquisição.">
      <p><a className="btn gold" href={`https://wa.me/${CENTRAL_WA}?text=${encodeURIComponent('Olá! Vim pelo site da Dourado e gostaria de falar com a equipe.')}`} target="_blank" rel="noopener noreferrer" onClick={() => track('contact', { method: 'whatsapp_central' })}>Conversar pelo WhatsApp</a></p>
      <p className="small muted">Número central de demonstração. Configure o número oficial no painel, em Atendimento e WhatsApp.</p>
      <ContactForm kind="contato" submitLabel="Enviar mensagem" extra={['company']} />
    </Page>
  );
}

export function Privacy() {
  return (
    <Page title="Privacidade e dados pessoais" lede="Como a Dourado trata os dados enviados pela plataforma.">
      <p className="notice">Texto provisório para revisão jurídica.</p>
      <p>Usamos nome, telefone, e-mail e empresa apenas para responder ao seu interesse e apresentar oportunidades compatíveis, com base no seu consentimento. Registramos a origem da visita (campanha e canal) para medir resultados. Endereços IP são guardados apenas como código irreversível.</p>
      <p>Você pode pedir acesso, correção ou exclusão dos seus dados pelo contato da Dourado. Cliques sem dados pessoais têm a origem anonimizada após 24 meses.</p>
    </Page>
  );
}
