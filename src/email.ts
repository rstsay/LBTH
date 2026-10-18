import nodemailer, { type Transporter } from "nodemailer";
import type { MagicLinkSender } from "./auth.ts";

export class SmtpMagicLinkSender implements MagicLinkSender {
  private readonly transporter: Transporter;
  private readonly from: string;

  constructor(
    from: string,
    options: {
      host: string;
      port: number;
      secure: boolean;
      user?: string;
      password?: string;
    },
  ) {
    this.from = from;
    this.transporter = nodemailer.createTransport({
      host: options.host,
      port: options.port,
      secure: options.secure,
      auth:
        options.user !== undefined && options.password !== undefined
          ? { user: options.user, pass: options.password }
          : undefined,
    });
  }

  async send(email: string, url: string): Promise<void> {
    await this.transporter.sendMail({
      from: this.from,
      to: email,
      subject: "LBS 虛擬尋寶登入連結",
      text: `請在 15 分鐘內開啟以下連結並確認登入：\n${url}\n\n若你沒有要求登入，請忽略此信。`,
      html: `<p>請在 15 分鐘內開啟以下連結並確認登入：</p><p><a href="${escapeHtml(url)}">確認登入</a></p><p>若你沒有要求登入，請忽略此信。</p>`,
    });
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
