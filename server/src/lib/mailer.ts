/** E-mail transacional opcional (SMTP_URL). Sem SMTP, o administrador copia o link e envia pelo canal que preferir. */
import nodemailer from 'nodemailer';
import { config } from '../config.js';

export const mailEnabled = () => !!config.smtpUrl;

export async function sendMail(to: string, subject: string, text: string): Promise<boolean> {
  if (!config.smtpUrl) return false;
  try {
    await nodemailer.createTransport(config.smtpUrl).sendMail({ from: config.mailFrom, to, subject, text });
    return true;
  } catch (e: any) {
    console.error(JSON.stringify({ level: 'error', msg: 'Falha ao enviar e-mail', error: e.message }));
    return false;
  }
}
