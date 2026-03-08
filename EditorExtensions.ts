import type { Extension } from '@codemirror/state';
import { EditorView, hoverTooltip, type Tooltip } from '@codemirror/view';

import type ZotsidianPlugin from 'main';
import { extractCitationMentions, type CitationMention } from 'ReferenceProcessing';

function findCitationMentionAt(docText: string, pos: number): CitationMention | null {
  const mentions = extractCitationMentions(docText);
  for (const mention of mentions) {
    if (pos >= mention.from && pos <= mention.to) {
      return mention;
    }
  }
  return null;
}

function setExternalLinkAttrs(link: HTMLAnchorElement, href: string) {
  link.href = href;
  if (href.startsWith('http')) {
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
  }
}

function semanticScholarUrl(doi: string, title: string): string {
  return doi
    ? `https://www.semanticscholar.org/search?q=${encodeURIComponent(doi)}`
    : (title ? `https://www.semanticscholar.org/search?q=${encodeURIComponent(title)}` : '');
}

function googleScholarUrl(doi: string, title: string): string {
  return doi
    ? `https://scholar.google.com/scholar?q=${encodeURIComponent(doi)}`
    : (title ? `https://scholar.google.com/scholar?q=${encodeURIComponent(title)}` : '');
}

function connectedPapersUrl(doi: string, title: string): string {
  return doi
    ? `https://www.connectedpapers.com/api/redirect/doi/${encodeURIComponent(doi)}`
    : (title ? `https://www.connectedpapers.com/search?q=${encodeURIComponent(title)}` : '');
}

function renderHoverCardBody(plugin: ZotsidianPlugin, mount: HTMLElement, citekey: string) {
  mount.replaceChildren();
  mount.createEl('div', { cls: 'zotsidian-hover-citekey', text: `@${citekey}` });
  mount.createEl('div', { cls: 'zotsidian-hover-loading', text: 'Loading citation…' });
}

async function hydrateHoverCard(plugin: ZotsidianPlugin, mount: HTMLElement, citekey: string) {
  const activeFile = plugin.app.workspace.getActiveFile();
  const cache = activeFile ? plugin.app.metadataCache.getFileCache(activeFile) : null;
  const scope = plugin.resolveScopeFromFrontmatter(cache?.frontmatter as Record<string, unknown> | undefined);
  const data = await plugin.getCitationHoverData(scope, citekey);
  if (!mount.isConnected) return;

  mount.replaceChildren();
  mount.createEl('div', { cls: 'zotsidian-hover-citekey', text: `@${citekey}` });

  if (!data) {
    mount.createEl('div', { cls: 'zotsidian-hover-empty', text: 'No citation metadata found.' });
    return;
  }

  mount.createEl('div', { cls: 'zotsidian-hover-title', text: data.title || citekey });
  const meta = [
    data.authors.length > 0 ? (data.authors.length > 2 ? `${data.authors[0]} et al.` : data.authors.join(' & ')) : '',
    data.journal,
    data.year,
  ].filter((part) => part && part.length > 0).join(' · ');
  if (meta) {
    mount.createEl('div', { cls: 'zotsidian-hover-meta', text: meta });
  }
  if (data.doi) {
    const doiWrap = mount.createDiv({ cls: 'zotsidian-hover-doi' });
    const doiLink = doiWrap.createEl('a', { text: data.doi });
    setExternalLinkAttrs(doiLink, `https://doi.org/${data.doi}`);
  }

  mount.createEl('div', {
    cls: `zotsidian-hover-status ${data.inLibrary ? 'is-in-library' : 'is-missing-library'}`,
    text: data.inLibrary ? 'In Zotero' : 'Not found in Zotero',
  });

  const actions = mount.createDiv({ cls: 'zotsidian-hover-actions' });
  const addZoteroAction = (label: string, href: string | null) => {
    if (!href) return;
    const link = actions.createEl('a', { cls: 'zotsidian-hover-action', text: label });
    setExternalLinkAttrs(link, href);
  };

  if (plugin.settings.citationHoverOpenAction === 'pdf-first') {
    addZoteroAction('Open PDF', data.pdfUri);
    addZoteroAction('Open in Zotero', data.zoteroUri);
  } else {
    addZoteroAction('Open in Zotero', data.zoteroUri);
    addZoteroAction('Open PDF', data.pdfUri);
  }

  const secondaryActions = mount.createDiv({ cls: 'zotsidian-hover-secondary-actions' });
  const addSecondaryAction = (label: string, href: string) => {
    if (!href) return;
    const link = secondaryActions.createEl('a', { cls: 'zotsidian-hover-action zotsidian-hover-action-secondary', text: label });
    setExternalLinkAttrs(link, href);
  };

  const sourceActionLabel = data.sourceNotePath ? 'Source Page' : 'Create Source Page';
  const sourceAction = secondaryActions.createEl('a', {
    cls: 'zotsidian-hover-action zotsidian-hover-action-secondary',
    text: sourceActionLabel,
    href: '#',
  });
  sourceAction.addEventListener('click', async (evt) => {
    evt.preventDefault();
    await plugin.openOrCreateSourcePage(citekey, data.title);
  });

  addSecondaryAction('Semantic Scholar', semanticScholarUrl(data.doi, data.title));
  addSecondaryAction('Google Scholar', googleScholarUrl(data.doi, data.title));
  addSecondaryAction('Connected Papers', connectedPapersUrl(data.doi, data.title));

  if (secondaryActions.childElementCount === 0) {
    secondaryActions.remove();
  }

  if (data.attachments.length > 0) {
    const attachmentWrap = mount.createDiv({ cls: 'zotsidian-hover-attachments' });
    attachmentWrap.createEl('div', { cls: 'zotsidian-hover-subtitle', text: 'Attachments' });
    for (const attachment of data.attachments.slice(0, 5)) {
      const link = attachmentWrap.createEl('a', { cls: 'zotsidian-hover-attachment', text: attachment.label });
      setExternalLinkAttrs(link, attachment.open);
    }
  }
}

export function createCitationHoverCardElement(plugin: ZotsidianPlugin, citekey: string): HTMLElement {
  const dom = document.createElement('div');
  dom.className = 'zotsidian-hover-card';
  renderHoverCardBody(plugin, dom, citekey);
  void hydrateHoverCard(plugin, dom, citekey).catch((error) => {
    if (!dom.isConnected) return;
    dom.replaceChildren();
    dom.createEl('div', { cls: 'zotsidian-hover-citekey', text: `@${citekey}` });
    dom.createEl('div', { cls: 'zotsidian-hover-empty', text: error instanceof Error ? error.message : String(error) });
  });
  return dom;
}

export function createCitationHoverExtension(plugin: ZotsidianPlugin): Extension {
  return hoverTooltip((view: EditorView, pos: number): Tooltip | null => {
    if (!plugin.settings.showCitationHoverCard) return null;

    const docText = view.state.doc.toString();
    const mention = findCitationMentionAt(docText, pos);
    if (!mention) return null;

    return {
      pos: mention.from,
      end: mention.to,
      above: false,
      create() {
        const dom = createCitationHoverCardElement(plugin, mention.citekey);
        return { dom };
      }
    };
  }, { hoverTime: 250 });
}
