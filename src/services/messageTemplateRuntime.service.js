import { adminContactEmailHtml } from './mail.templates.js';
import {
  getActiveTemplateById,
  getActiveTemplateByKey,
  renderTemplateVariables,
} from './messageTemplate.service.js';

export async function resolveEmailContent({ key, variables = {}, fallback = {} }) {
  if (!key) {
    return {
      subject: fallback.subject || '',
      html: fallback.html || '',
      text: fallback.text || '',
      fromTemplate: false,
    };
  }

  const template = await getActiveTemplateByKey(key, 'email');
  if (!template) {
    return {
      subject: fallback.subject || '',
      html: fallback.html || '',
      text: fallback.text || '',
      fromTemplate: false,
    };
  }

  const subject = renderTemplateVariables(template.subject, variables);
  const body = renderTemplateVariables(template.body, variables);
  return {
    subject,
    html: adminContactEmailHtml(body),
    text: body,
    fromTemplate: true,
    templateId: template.id,
  };
}

export async function resolveSmsContent({ key, variables = {}, fallback = '' }) {
  if (!key) {
    return { message: fallback, fromTemplate: false };
  }

  const template = await getActiveTemplateByKey(key, 'sms');
  if (!template) {
    return { message: fallback, fromTemplate: false };
  }

  return {
    message: renderTemplateVariables(template.body, variables),
    fromTemplate: true,
    templateId: template.id,
  };
}

export async function resolveManualEmailFromTemplateId(templateId, variables = {}) {
  const template = await getActiveTemplateById(templateId);
  if (!template || template.type !== 'Email') {
    return null;
  }

  const subject = renderTemplateVariables(template.subject, variables);
  const body = renderTemplateVariables(template.body, variables);
  return {
    subject,
    html: adminContactEmailHtml(body),
    text: body,
  };
}

export async function resolveManualSmsFromTemplateId(templateId, variables = {}) {
  const template = await getActiveTemplateById(templateId);
  if (!template || template.type !== 'SMS') {
    return null;
  }

  return {
    message: renderTemplateVariables(template.body, variables),
  };
}
