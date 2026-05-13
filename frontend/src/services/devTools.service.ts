/**
 * Admin → Dev tools API client. Gated server-side by the
 * `crmDevelopment` feature flag; the frontend additionally hides
 * the page when the flag is off, but the API check is what
 * actually enforces the gate.
 */
import { api } from '../config/api';

export type CrmEmailTemplateKey =
  | 'quote_sent'
  | 'quote_accepted_customer'
  | 'quote_accepted_admin'
  | 'quote_declined_admin'
  | 'invoice_sent'
  | 'invoice_reminder_first'
  | 'invoice_reminder_second'
  | 'invoice_payment_check_admin';

export interface DevEmailTemplateStatus {
  key: CrmEmailTemplateKey;
  present: boolean;
}

export const devToolsService = {
  async listEmailTemplates(): Promise<DevEmailTemplateStatus[]> {
    const { data } = await api.get('/admin/dev/email-templates');
    return (data.data || data).templates;
  },

  async sendTestEmail(templateKey: CrmEmailTemplateKey): Promise<{
    sent: true;
    to: string;
    template: CrmEmailTemplateKey;
  }> {
    const { data } = await api.post('/admin/dev/send-test-email', { templateKey });
    return data.data || data;
  },
};
