import { loadConfig } from '../config.js';

export function wikiUrl(path = ''): string {
  return `${loadConfig().wikiUrl}/${path}`;
}

export function logHelpUrl(): string {
  return wikiUrl('faq/#how-do-i-upload-logs-for-troubleshooting');
}

export function galaxyUpdateUrl(): string {
  return wikiUrl('software/starpilot/#using-galaxy-recommended');
}
