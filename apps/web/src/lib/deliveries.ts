import type { DeliveryLog } from './types';

const CHANNEL: Record<string, string> = { email: 'Email', whatsapp: 'WhatsApp message', webhook: 'Webhook', none: 'Notification' };

/** "WhatsApp message could not be sent". */
export function deliveryTitle(d: DeliveryLog): string {
  const what = CHANNEL[d.channel] ?? 'Notification';
  if (d.status === 'failed') return `${what} could not be sent`;
  if (d.status === 'skipped') return `${what} was not sent`;
  if (d.status === 'pending') return `${what} is being sent`;
  return `${what} sent`;
}

/**
 * Plain steps to fix a failed or skipped delivery, from the channel and the provider's error text.
 * Shown to admins on the record page next to the step the message belongs to.
 */
export function deliveryAdvice(d: DeliveryLog): string[] {
  const e = (d.error ?? '').toLowerCase();
  const out: string[] = [];
  if (d.status === 'skipped') {
    if (/recipient|nobody|no one|no email|no phone/.test(e)) out.push('Nobody to send to: add people to the step’s owner groups (All Users), or assign users to the step, and make sure they have an email / WhatsApp number.');
    if (/not configured|no active|connection|channel/.test(e)) out.push(`Switch on a ${d.channel === 'whatsapp' ? 'WhatsApp' : 'email'} connection in Settings › Connections.`);
    if (!out.length) out.push('Check the flow’s Notifications settings (channels and hand-offs) in the flow editor.');
    return out;
  }
  if (d.channel === 'whatsapp') {
    if (/not configured|no active|connection/.test(e)) out.push('Settings › Connections: add a WhatsApp connection (access token and phone number ID), switch it on and press Test.');
    if (/template|132000|132001|132012|translation|parameter/.test(e)) out.push('Check that the template name and language in the message match a template Meta has approved.', 'The message variables must match the template’s {{1}}, {{2}}… in number and order.');
    if (/number|recipient|phone|131026|131009|invalid/.test(e)) out.push('Use the number with its country code and no spaces, e.g. 91XXXXXXXXXX.', 'The person must use WhatsApp on that number.');
    if (/token|auth|oauth|401|\b190\b|expired/.test(e)) out.push('The access token was refused or has expired: paste a new one in Settings › Connections and press Test.');
    if (!out.length) out.push('Open Settings › Connections and press Test on the WhatsApp connection.', 'Check that the recipient number has its country code (e.g. 91XXXXXXXXXX).');
  } else if (d.channel === 'email') {
    if (/not configured|no active|connection/.test(e)) out.push('Settings › Connections: switch on an email connection (SMTP, Google or Microsoft) and press Test.');
    if (/auth|535|credential|password|login/.test(e)) out.push('The mail server refused the sign-in: enter the password (or app password) again in Settings › Connections and press Test.');
    if (/550|mailbox|recipient|address|rejected/.test(e)) out.push('The address was refused: check the person’s email in All Users.');
    if (!out.length) out.push('Open Settings › Connections and press Test on the email connection.');
  } else if (d.channel === 'webhook') {
    if (/private|blocked|not allowed/.test(e)) out.push('The URL points to a private network address, which is blocked for safety: use a public https address.');
    else out.push('The receiving system answered with an error or did not answer: check that it is running and accepts POST requests at this URL.');
  } else {
    out.push('Check Settings › Connections and the flow’s Notifications settings.');
  }
  out.push(d.attempts < 5 ? 'It is retried automatically (after 5, 10, 20 and 40 minutes).' : 'It was tried 5 times and will not be retried; messages for later steps are sent normally once the cause is fixed.');
  return out;
}
