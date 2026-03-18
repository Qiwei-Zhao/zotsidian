
import { App, ItemView, WorkspaceLeaf, Modal, Menu, setIcon, TFile } from 'obsidian';

import ZotsidianPlugin, { type SourceRelatedData, type SourceRelatedEntry, type SourceRelatedLibraryItem, type SourceRelatedMatch } from 'main';
import { createCitationHoverCardElement } from 'EditorExtensions';

import { FrontMatterScopeProperty } from "FrontMatter"
import { attachments } from 'ZoteroFunctions';
import { CollectionData, citationsInText } from "ReferenceProcessing";


export const ReferencesViewType = 'ReferencesView';

type ReferenceSortMode = 'insertion' | 'year' | 'author-year';
type SidebarAnnotation = {
  key: string;
  parentItem: string;
  annotationType?: string;
  annotationColor?: string;
  annotationComment?: string;
  annotationText?: string;
  annotationAuthorName?: string;
  dateAdded?: string;
  dateModified?: string;
};

type SidebarAttachmentRow = {
  open?: string;
  path?: boolean;
  label?: string;
  annotations?: SidebarAnnotation[];
};



export class ReferencesView extends ItemView {
  plugin: ZotsidianPlugin;
  references: [];
  private _fileCollectionData: Map<string, CollectionData>;
  private _referenceSortMode: ReferenceSortMode;
  private _hoverCardEl: HTMLElement | null;
  private _hoverTargetEl: HTMLElement | null;
  private _hoverHideTimer: number | null;
  private _hoverSwitchTimer: number | null;
  private _statusEl: HTMLElement | null;
  private _refreshButtonEl: HTMLButtonElement | null;
  private _headerScope: string | null;
  private _headerDetectedMentions: number;

  constructor(leaf: WorkspaceLeaf, plugin: ZotsidianPlugin) {
    super(leaf);
    this.plugin = plugin;
    this._fileCollectionData = new Map()
    this._referenceSortMode = 'insertion';
    this._hoverCardEl = null;
    this._hoverTargetEl = null;
    this._hoverHideTimer = null;
    this._hoverSwitchTimer = null;
    this._statusEl = null;
    this._refreshButtonEl = null;
    this._headerScope = null;
    this._headerDetectedMentions = 0;
    this.contentEl.addClass('zotsidian-references');
    this.setEmptyView();
    
    this.addAction("refresh-cw", "Refresh", async () => {
      await this.refreshReferences();
    });
            
  }

  get activeFilePath():string {
    return this.plugin.activeFilePath;
  }

  get activeFileCollectionData():CollectionData | undefined {
    return this._fileCollectionData.get(this.activeFilePath);
  }

  private getReferenceSortLabel(): string {
    if (this._referenceSortMode === 'year') return 'Sort: Year (newest first)';
    if (this._referenceSortMode === 'author-year') return 'Sort: Author + year';
    return 'Sort: Insertion order';
  }

  private getLeadAuthor(itemData: Record<string, unknown>): string {
    const creators = Array.isArray(itemData['creators']) ? itemData['creators'] : Array.isArray(itemData['author']) ? itemData['author'] : [];
    if (creators.length === 0) return '';
    const first = creators[0] as Record<string, unknown>;
    if (typeof first['family'] === 'string' && first['family']) return first['family'];
    if (typeof first['lastName'] === 'string' && first['lastName']) return first['lastName'];
    if (typeof first['literal'] === 'string' && first['literal']) return first['literal'];
    if (typeof first['name'] === 'string' && first['name']) return first['name'];
    return '';
  }

  private getItemYear(itemData: Record<string, unknown>): number | null {
    const issued = itemData['issued'] as Record<string, unknown> | undefined;
    if (issued && 'date-parts' in issued) {
      const dateParts = issued['date-parts'] as unknown[];
      if (Array.isArray(dateParts) && Array.isArray(dateParts[0])) {
        const year = (dateParts[0] as unknown[])[0];
        if (typeof year === 'number' && Number.isFinite(year)) return year;
        if (typeof year === 'string') {
          const parsed = Number(year);
          if (Number.isFinite(parsed)) return parsed;
        }
      }
    }
    const direct = itemData['year'];
    if (typeof direct === 'number' && Number.isFinite(direct)) return direct;
    if (typeof direct === 'string') {
      const matched = direct.match(/(19|20)\d{2}/);
      if (matched) return Number(matched[0]);
    }
    return null;
  }

  private getAnnotationTypeLabel(annotationType?: string): string {
    const normalized = (annotationType || '').trim().toLowerCase();
    if (!normalized) return 'annotation';
    if (normalized === 'highlight') return 'highlight';
    if (normalized === 'note') return 'note';
    if (normalized === 'image') return 'image';
    return normalized;
  }

  private formatAnnotationDate(dateValue?: string): string {
    const value = typeof dateValue === 'string' ? dateValue.trim() : '';
    if (!value) return '';
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return value;
    return new Intl.DateTimeFormat(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    }).format(parsed);
  }

  private sortCitations(citations: string[], refs: CollectionData | undefined): string[] {
    const rows = [...citations];
    if (this._referenceSortMode === 'insertion') return rows;

    rows.sort((a, b) => {
      const aData = (refs?.data.get(a) || {}) as Record<string, unknown>;
      const bData = (refs?.data.get(b) || {}) as Record<string, unknown>;
      const aTitle = typeof aData['title'] === 'string' ? aData['title'] : a;
      const bTitle = typeof bData['title'] === 'string' ? bData['title'] : b;
      const aAuthor = this.getLeadAuthor(aData).toLowerCase();
      const bAuthor = this.getLeadAuthor(bData).toLowerCase();
      const aYear = this.getItemYear(aData);
      const bYear = this.getItemYear(bData);

      if (this._referenceSortMode === 'year') {
        if (aYear != null && bYear != null && aYear !== bYear) return bYear - aYear;
        if (aYear != null && bYear == null) return -1;
        if (aYear == null && bYear != null) return 1;
        return aTitle.localeCompare(bTitle);
      }

      if (aAuthor !== bAuthor) {
        if (!aAuthor) return 1;
        if (!bAuthor) return -1;
        return aAuthor.localeCompare(bAuthor);
      }
      if (aYear != null && bYear != null && aYear !== bYear) return aYear - bYear;
      if (aYear != null && bYear == null) return -1;
      if (aYear == null && bYear != null) return 1;
      return aTitle.localeCompare(bTitle);
    });

    return rows;
  }

  private clearHoverTimers() {
    if (this._hoverHideTimer != null) {
      window.clearTimeout(this._hoverHideTimer);
      this._hoverHideTimer = null;
    }
    if (this._hoverSwitchTimer != null) {
      window.clearTimeout(this._hoverSwitchTimer);
      this._hoverSwitchTimer = null;
    }
  }

  private hideReferenceHoverCard() {
    this.clearHoverTimers();
    if (this._hoverCardEl) {
      this._hoverCardEl.remove();
      this._hoverCardEl = null;
    }
    this._hoverTargetEl = null;
  }

  private scheduleHideReferenceHoverCard() {
    if (this._hoverHideTimer != null) window.clearTimeout(this._hoverHideTimer);
    this._hoverHideTimer = window.setTimeout(() => {
      this.hideReferenceHoverCard();
    }, 90);
  }

  private positionReferenceHoverCard(card: HTMLElement, target: HTMLElement) {
    const rect = target.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const gap = 8;
    const fitsLeft = rect.left - gap - cardRect.width >= 12;
    const fitsRight = rect.right + gap + cardRect.width <= viewportWidth - 12;
    let left = rect.left;
    let top = rect.top;

    if (fitsLeft) left = rect.left - cardRect.width - gap;
    else if (fitsRight) left = rect.right + gap;
    else left = Math.max(12, viewportWidth - cardRect.width - 12);

    if (top + cardRect.height > viewportHeight - 12) {
      top = Math.max(12, viewportHeight - cardRect.height - 12);
    }

    card.style.left = `${Math.round(left)}px`;
    card.style.top = `${Math.round(top)}px`;
  }

  private showReferenceHoverCard(target: HTMLElement, citekey: string) {
    this.clearHoverTimers();
    if (this._hoverTargetEl === target && this._hoverCardEl?.isConnected) {
      this.positionReferenceHoverCard(this._hoverCardEl, target);
      return;
    }
    this.hideReferenceHoverCard();
    const card = createCitationHoverCardElement(this.plugin, citekey);
    card.classList.add('zotsidian-sidebar-hover-card');
    card.addEventListener('mouseenter', () => {
      this.clearHoverTimers();
    });
    card.addEventListener('mouseleave', () => {
      this.scheduleHideReferenceHoverCard();
    });
    document.body.appendChild(card);
    this._hoverCardEl = card;
    this._hoverTargetEl = target;
    this.positionReferenceHoverCard(card, target);
    window.requestAnimationFrame(() => {
      if (this._hoverCardEl === card && this._hoverTargetEl === target) {
        this.positionReferenceHoverCard(card, target);
      }
    });
  }

  private scheduleSwitchReferenceHoverCard(target: HTMLElement, citekey: string) {
    if (this._hoverSwitchTimer != null) window.clearTimeout(this._hoverSwitchTimer);
    this._hoverSwitchTimer = window.setTimeout(() => {
      this._hoverSwitchTimer = null;
      this.showReferenceHoverCard(target, citekey);
    }, 120);
  }

  private attachReferenceHover(rowEl: HTMLElement, citekey: string) {
    rowEl.addEventListener('mouseenter', () => {
      if (!this.plugin.settings.showCitationHoverCard) return;
      if (this._hoverCardEl?.isConnected && this._hoverTargetEl && this._hoverTargetEl !== rowEl) {
        this.scheduleSwitchReferenceHoverCard(rowEl, citekey);
        return;
      }
      this.showReferenceHoverCard(rowEl, citekey);
    });
    rowEl.addEventListener('mouseleave', (evt: MouseEvent) => {
      const related = evt.relatedTarget;
      if (
        related instanceof Node &&
        (rowEl.contains(related) || this._hoverCardEl?.contains(related))
      ) {
        return;
      }
      this.scheduleHideReferenceHoverCard();
    });
  }

  private addSortMenuButton(header: HTMLElement) {
    const sortButton = header.createEl("button", {
      cls: "sort-button",
      title: this.getReferenceSortLabel(),
    });
    setIcon(sortButton, "arrow-up-down");
    sortButton.onclick = (evt) => {
      evt.preventDefault();
      evt.stopPropagation();
      const menu = new Menu();
      const addItem = (mode: ReferenceSortMode, title: string) => {
        menu.addItem((item) => {
          item
            .setTitle(title)
            .setChecked(this._referenceSortMode === mode)
            .onClick(async () => {
              this._referenceSortMode = mode;
              await this.renderReferences();
            });
        });
      };
      addItem('insertion', 'Insertion order');
      addItem('year', 'Year (newest first)');
      addItem('author-year', 'Author + year');
      menu.showAtMouseEvent(evt);
    };
  }

  refreshHeaderStatus(scopeOverride?: string, detectedMentionsOverride?: number) {
    if (typeof scopeOverride === 'string') {
      this._headerScope = scopeOverride;
    }
    if (typeof detectedMentionsOverride === 'number') {
      this._headerDetectedMentions = detectedMentionsOverride;
    }
    if (!this._statusEl) return;

    const display = this.plugin.getCitationIndexStatusDisplay(this._headerScope || undefined, this._headerDetectedMentions);
    this._statusEl.empty();
    this._statusEl.removeClasses(['is-connected', 'is-loading', 'is-degraded', 'is-offline']);
    this._statusEl.toggleClass('is-hidden', !display.label);
    if (!display.label) {
      this._statusEl.setAttribute('title', '');
    } else {
      this._statusEl.setText(display.label);
      this._statusEl.setAttribute('title', display.title);
      this._statusEl.addClass(`is-${display.tone}`);
    }

    if (this._refreshButtonEl) {
      const status = this.plugin.getCitationIndexStatus(this._headerScope || undefined);
      this._refreshButtonEl.toggleClass('is-loading', status.loading);
      this._refreshButtonEl.setAttribute('aria-busy', status.loading ? 'true' : 'false');
      this._refreshButtonEl.setAttribute('title', status.loading ? 'Refreshing Zotero index' : 'Refresh');
    }
  }

  private emptyCollectionData(path:string='', library:string=''): CollectionData {
    return {
      path,
      library,
      citations: [],
      bibliography: [],
      data: new Map(),
      annotationsMap: new Map()
    };
  }

  private resolveCollectionPath(frontMatter: Record<string, unknown> | null | undefined): string {
    const bib = frontMatter?.[FrontMatterScopeProperty];
    if (typeof bib === 'string' && bib.trim().length > 0) {
      return bib.trim();
    }
    return this.plugin.resolveScopeFromFrontmatter(frontMatter);
  }

  private async buildCollectionDataForFile(activeFile:TFile): Promise<CollectionData> {
    const cache = this.plugin.app.metadataCache.getFileCache(activeFile);
    const frontMatter = cache?.frontmatter as Record<string, unknown> | undefined;
    const collectionPath = this.resolveCollectionPath(frontMatter);
    const baseCitations = this.plugin.getVisibleCitationsFromActiveContext(activeFile);
    const parsed = Array.isArray(baseCitations)
      ? baseCitations
      : citationsInText(await this.plugin.app.vault.cachedRead(activeFile));
    const citedUnique = [...new Set(parsed)];
    const citationMap = await this.plugin.getCitationMapFor(collectionPath, citedUnique);
    const citations = citedUnique.filter((cite) => citationMap.has(cite));
    const data = new Map<string, object>(citations.map((cite) => [cite, citationMap.get(cite) as object]));
    return {
      path: collectionPath,
      library: collectionPath.split('/')[0] ?? '',
      citations: citations,
      detectedCitations: citedUnique,
      bibliography: citations,
      data: data,
      annotationsMap: new Map(),
    };
  }

  private zoteroUriFromItemData(itemData: Record<string, unknown>): string {
    const explicitZotero = typeof itemData['zotero'] === 'string' ? itemData['zotero'] : '';
    if (explicitZotero.startsWith('zotero://')) {
      return explicitZotero;
    }

    const itemId = typeof itemData['zoteroItemID'] === 'string' ? itemData['zoteroItemID'] : '';
    if (itemId) {
      if (itemId.startsWith('zotero://')) {
        return itemId;
      }
      const groupMatch = itemId.match(/\/groups\/([0-9]+)\/items\/([A-Z0-9]{8})/i);
      if (groupMatch?.[1] && groupMatch?.[2]) {
        return `zotero://select/groups/${groupMatch[1]}/items/${groupMatch[2]}`;
      }
      const userMatch = itemId.match(/\/users\/([0-9]+)\/items\/([A-Z0-9]{8})/i);
      if (userMatch?.[2]) {
        return `zotero://select/library/items/${userMatch[2]}`;
      }
    }
    const itemKey = typeof itemData['itemKey'] === 'string' && itemData['itemKey']
      ? itemData['itemKey'] as string
      : (typeof itemData['zotero-key'] === 'string' ? itemData['zotero-key'] as string : '');
    if (itemKey) {
      return `zotero://select/library/items/${itemKey}`;
    }
    return '';
  }

  private zoteroSelectUriFromItemData(itemData: Record<string, unknown>): string {
    const explicitZotero = typeof itemData['zotero'] === 'string' ? itemData['zotero'] : '';
    if (explicitZotero.startsWith('zotero://select/')) {
      return explicitZotero;
    }
    if (explicitZotero.startsWith('zotero://open-pdf/')) {
      return explicitZotero.replace('zotero://open-pdf/', 'zotero://select/');
    }

    const itemId = typeof itemData['zoteroItemID'] === 'string' ? itemData['zoteroItemID'] : '';
    if (itemId) {
      const groupMatch = itemId.match(/\/groups\/([0-9]+)\/items\/([A-Z0-9]{8})/i);
      if (groupMatch?.[1] && groupMatch?.[2]) {
        return `zotero://select/groups/${groupMatch[1]}/items/${groupMatch[2]}`;
      }
      const userMatch = itemId.match(/\/users\/([0-9]+)\/items\/([A-Z0-9]{8})/i);
      if (userMatch?.[2]) {
        return `zotero://select/library/items/${userMatch[2]}`;
      }
    }

    const itemKey = this.parseItemKey(itemData);
    if (itemKey) {
      return `zotero://select/library/items/${itemKey}`;
    }

    return '';
  }

  private googleScholarUrlFromItemData(itemData: Record<string, unknown>): string {
    const doi = typeof itemData['DOI'] === 'string' ? itemData['DOI'].trim() : '';
    if (doi) {
      return `https://scholar.google.com/scholar?q=${encodeURIComponent(doi)}`;
    }
    const title = typeof itemData['title'] === 'string' ? itemData['title'].trim() : '';
    if (title) {
      return `https://scholar.google.com/scholar?q=${encodeURIComponent(title)}`;
    }
    return '';
  }

  private parseItemKey(itemData: Record<string, unknown>): string {
    const candidates = [
      itemData['itemKey'],
      itemData['zotero-key'],
    ];
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && /^[A-Z0-9]{8}$/i.test(candidate)) {
        return candidate.toUpperCase();
      }
    }
    const uriCandidates = [itemData['zoteroItemID'], itemData['zotero'], itemData['id']];
    for (const uri of uriCandidates) {
      if (typeof uri !== 'string') continue;
      const matched = uri.match(/items\/([A-Z0-9]{8})/i);
      if (matched?.[1]) return matched[1].toUpperCase();
    }
    return '';
  }

  private getActiveSourceCitekey(): string | null {
    const activeFile = this.plugin.app.workspace.getActiveFile();
    if (!activeFile || activeFile.extension !== 'md') return null;
    if (!activeFile.basename.startsWith('@')) return null;
    const key = activeFile.basename.replace(/^@+/, '').trim();
    return key.length > 0 ? key : null;
  }

  private setSourceViewContent(content: HTMLElement, scope?: string, detectedMentions: number = 0) {
    this.hideReferenceHoverCard();
    this.contentEl.empty();
    const containerDiv = this.contentEl.createDiv({ cls: "zotsidian-container-div" });
    const header = containerDiv.createDiv({ cls: "references-header" });
    header.createEl("span", { text: "SOURCE", cls: "references-header-text" });
    this._statusEl = header.createDiv({ cls: 'zotsidian-status-pill is-hidden' });
    const refreshButton = header.createEl("button", { cls: "refresh-button", title: "Refresh" });
    this._refreshButtonEl = refreshButton;
    setIcon(refreshButton, "refresh-cw");
    const searchButton = header.createEl("button", { cls: "search-button", title: "Search Zotero library" });
    setIcon(searchButton, "search");
    this.addSortMenuButton(header);
    refreshButton.onclick = async () => {
      await this.refreshReferences();
      await this.renderReferences();
    };
    searchButton.onclick = () => {
      this.plugin.openSearchPanel();
    };
    this._headerScope = scope || this.plugin.getActiveScope();
    this._headerDetectedMentions = detectedMentions;
    this.refreshHeaderStatus();
    containerDiv.appendChild(content);
  }

  private getScopeForSource(frontMatter: Record<string, unknown> | null | undefined): string {
    return this.resolveCollectionPath(frontMatter);
  }

  private mergeSourceData(citekey: string, raw: Record<string, unknown> | undefined, frontMatter: Record<string, unknown> | undefined): Record<string, unknown> {
    const merged: Record<string, unknown> = { ...(raw || {}) };
    const fm = frontMatter || {};
    if ((!merged['id'] || typeof merged['id'] !== 'string') && citekey) merged['id'] = citekey;
    if ((!merged['title'] || typeof merged['title'] !== 'string') && typeof fm['title'] === 'string') merged['title'] = fm['title'];
    if ((!merged['itemKey'] || typeof merged['itemKey'] !== 'string') && typeof fm['zotero-key'] === 'string') merged['itemKey'] = fm['zotero-key'];
    if ((!merged['zotero-key'] || typeof merged['zotero-key'] !== 'string') && typeof fm['zotero-key'] === 'string') merged['zotero-key'] = fm['zotero-key'];
    if ((!merged['zotero'] || typeof merged['zotero'] !== 'string') && typeof fm['zotero'] === 'string') merged['zotero'] = fm['zotero'];
    if ((!merged['zoteroItemID'] || typeof merged['zoteroItemID'] !== 'string') && typeof fm['zotero'] === 'string') merged['zoteroItemID'] = fm['zotero'];
    if ((!merged['DOI'] || typeof merged['DOI'] !== 'string') && typeof fm['DOI'] === 'string') merged['DOI'] = fm['DOI'];
    if ((!merged['journal'] || typeof merged['journal'] !== 'string') && typeof fm['journal'] === 'string') merged['journal'] = fm['journal'];
    if ((!merged['year'] || typeof merged['year'] !== 'string') && typeof fm['year'] === 'string') merged['year'] = fm['year'];
    return merged;
  }

  private async renderSourceInspector(citekey: string, refs?: CollectionData) {
    const activeFile = this.plugin.app.workspace.getActiveFile();
    if (!activeFile) {
      this.setEmptyView();
      return;
    }

    const cache = this.plugin.app.metadataCache.getFileCache(activeFile);
    const frontMatter = cache?.frontmatter as Record<string, unknown> | undefined;
    const scope = this.getScopeForSource(frontMatter);
    const citationMap = await this.plugin.getCitationMapFor(scope, [citekey]);
    const itemData = this.mergeSourceData(citekey, citationMap.get(citekey), frontMatter);

    const containerDiv = document.createElement('div');
    containerDiv.classList.add('zotsidian-source-div');

    const title = typeof itemData['title'] === 'string' && itemData['title'] ? itemData['title'] : `@${citekey}`;
    const journal = typeof itemData['journal'] === 'string' ? itemData['journal'] : (typeof itemData['container-title'] === 'string' ? itemData['container-title'] : '');
    const year = typeof itemData['year'] === 'string' ? itemData['year'] : '';
    const doi = typeof itemData['DOI'] === 'string' ? itemData['DOI'] : '';
    const relatedPromise = this.plugin.settings.showSourceRelatedPapers
      ? this.plugin.getSourceRelatedData(scope, citekey, itemData).catch(() => null)
      : Promise.resolve(null);

    containerDiv.createEl('div', { cls: 'zotsidian-source-citekey', text: `@${citekey}` });
    containerDiv.createEl('div', { cls: 'zotsidian-source-title', text: title });
    if (journal || year) {
      containerDiv.createEl('div', { cls: 'zotsidian-source-journal', text: `${journal}${journal && year ? ' ' : ''}${year}` });
    }
    if (doi) {
      const doiLine = containerDiv.createDiv({ cls: 'zotsidian-source-doi' });
      doiLine.createEl('a', { href: `https://doi.org/${doi}`, text: doi });
    }

    const actions = containerDiv.createDiv({ cls: 'zotsidian-source-actions' });
    const selectUri = this.zoteroSelectUriFromItemData(itemData);
    if (selectUri) {
      actions.createEl('a', { cls: 'zotsidian-source-action', href: selectUri, text: 'Open in Zotero' });
    }
    const webUrl = typeof itemData['URL'] === 'string' && itemData['URL']
      ? itemData['URL']
      : (typeof itemData['id'] === 'string' && String(itemData['id']).startsWith('http') ? String(itemData['id']) : '');
    if (webUrl) {
      const webLink = actions.createEl('a', { cls: 'zotsidian-source-action', href: webUrl, text: 'Open URL' });
      webLink.setAttribute('target', '_blank');
      webLink.setAttribute('rel', 'noopener noreferrer');
    }
    const semanticScholarUrl = this.semanticScholarUrl(doi, title);
    if (semanticScholarUrl) {
      const semanticLink = actions.createEl('a', { cls: 'zotsidian-source-action', href: semanticScholarUrl, text: 'Semantic Scholar' });
      semanticLink.setAttribute('target', '_blank');
      semanticLink.setAttribute('rel', 'noopener noreferrer');
    }
    const googleScholarUrl = this.googleScholarUrlFromItemData(itemData);
    if (googleScholarUrl) {
      const scholarLink = actions.createEl('a', { cls: 'zotsidian-source-action', href: googleScholarUrl, text: 'Google Scholar' });
      scholarLink.setAttribute('target', '_blank');
      scholarLink.setAttribute('rel', 'noopener noreferrer');
    }
    const connectedPapersUrl = this.connectedPapersUrl(doi, title);
    if (connectedPapersUrl) {
      const cpLink = actions.createEl('a', { cls: 'zotsidian-source-action', href: connectedPapersUrl, text: 'Connected Papers' });
      cpLink.setAttribute('target', '_blank');
      cpLink.setAttribute('rel', 'noopener noreferrer');
    }

    if (this.plugin.settings.enableSidebarAttachments) {
      const attachmentHint = {
        itemKey: this.parseItemKey(itemData),
        zoteroItemID: (typeof itemData['zoteroItemID'] === 'string' ? itemData['zoteroItemID'] : undefined) as string | undefined,
        zotero: (typeof itemData['zotero'] === 'string' ? itemData['zotero'] : undefined) as string | undefined,
        citekey: (typeof itemData['id'] === 'string' ? itemData['id'] : citekey) as string | undefined,
        doi: (typeof itemData['DOI'] === 'string' ? itemData['DOI'] : undefined) as string | undefined,
        title: (typeof itemData['title'] === 'string' ? itemData['title'] : undefined) as string | undefined,
      };
      let attachmentRows: SidebarAttachmentRow[] = [];
      try {
        const rawAttachments = await attachments(citekey, scope.split('/')[0] || scope, attachmentHint);
        attachmentRows = Array.isArray(rawAttachments) ? rawAttachments as SidebarAttachmentRow[] : [];
      } catch (_err) {
        attachmentRows = [];
      }
      this.renderSourceAttachmentSections(containerDiv, attachmentRows);
    }

    const related = await relatedPromise;
    if (related) {
      this.renderSourceRelatedSection(containerDiv, related, scope);
    }

    this.renderInlineReferencesSection(containerDiv, refs, citekey);

    this.setSourceViewContent(containerDiv, scope, (refs?.detectedCitations || []).filter((key) => key !== citekey).length);
  }

  private wireSourcePageLink(linkEl: HTMLAnchorElement, citekey: string, title: string, itemData: Record<string, unknown>) {
    const existingFile = this.plugin.findSourceNoteFile(citekey);
    linkEl.setAttribute('href', existingFile?.path || '#');
    linkEl.setAttribute('data-citekey', citekey);
    linkEl.addClass(existingFile ? 'has-source-page' : 'is-missing-source-page');
    linkEl.setAttribute('title', existingFile ? 'Open existing source page' : 'Create source page');
    linkEl.addEventListener('click', async (evt) => {
      evt.preventDefault();
      await this.plugin.openOrCreateSourcePage(citekey, title, itemData);
    });
  }

  private openLinkTarget(href: string) {
    if (!href) return;
    const link = document.createElement('a');
    link.href = href;
    if (href.startsWith('http')) {
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
    }
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  private renderAnnotationCard(container: HTMLElement, annotation: SidebarAnnotation, openHref?: string) {
    const card = container.createDiv({
      cls: 'zotsidian-source-annotation-card',
      attr: {
        tabindex: '0',
        role: 'button',
      },
    });
    if (annotation.annotationColor) {
      card.style.setProperty('--annotation-color', annotation.annotationColor);
    }
    const activate = (evt?: Event) => {
      evt?.preventDefault();
      evt?.stopPropagation();
      if (openHref) {
        this.openLinkTarget(openHref);
      }
    };
    card.addEventListener('click', activate);
    card.addEventListener('keydown', (evt: KeyboardEvent) => {
      if (evt.key === 'Enter' || evt.key === ' ') {
        activate(evt);
      }
    });

    const topRow = card.createDiv({ cls: 'zotsidian-source-annotation-topline' });
    topRow.createSpan({
      cls: 'zotsidian-source-annotation-badge',
      text: this.getAnnotationTypeLabel(annotation.annotationType),
    });

    const dateLabel = this.formatAnnotationDate(annotation.dateModified || annotation.dateAdded);
    if (dateLabel) {
      topRow.createSpan({ cls: 'zotsidian-source-annotation-date', text: dateLabel });
    }

    if (annotation.annotationColor) {
      const colorDot = topRow.createSpan({ cls: 'zotsidian-source-annotation-color' });
      colorDot.setAttribute('title', annotation.annotationColor);
    }

    if (annotation.annotationText && annotation.annotationText.trim().length > 0) {
      card.createDiv({
        cls: 'zotsidian-source-annotation-text',
        text: annotation.annotationText.trim(),
      });
    }

    if (annotation.annotationComment && annotation.annotationComment.trim().length > 0) {
      card.createDiv({
        cls: 'zotsidian-source-annotation-comment',
        text: annotation.annotationComment.trim(),
      });
    }

    if (!annotation.annotationText?.trim() && !annotation.annotationComment?.trim()) {
      card.createDiv({
        cls: 'zotsidian-source-annotation-empty',
        text: 'No highlight text or comment available.',
      });
    }
  }

  private renderAttachmentLink(section: HTMLElement, row: SidebarAttachmentRow) {
    const attachmentLine = section.createDiv({ cls: 'zotsidian-source-attachment-line' });
    const label = typeof row.label === 'string' && row.label.trim().length > 0
      ? row.label.trim()
      : (typeof row.open === 'string' && row.open.startsWith('zotero://open-pdf/') ? 'Open PDF' : 'Open attachment');
    const link = attachmentLine.createEl('a', { href: row.open || '#', text: label });
    if (typeof row.open === 'string' && row.open.startsWith('http')) {
      link.setAttribute('target', '_blank');
      link.setAttribute('rel', 'noopener noreferrer');
    }
    const annotationCount = Array.isArray(row.annotations) ? row.annotations.length : 0;
    if (annotationCount > 0) {
      attachmentLine.createSpan({
        cls: 'zotsidian-source-attachment-count',
        text: `${annotationCount} annotation${annotationCount === 1 ? '' : 's'}`,
      });
    }
  }

  private renderSourceAttachmentSections(containerDiv: HTMLElement, attachmentRows: SidebarAttachmentRow[]) {
    const attachmentSection = containerDiv.createDiv({ cls: 'zotsidian-source-attachments' });
    attachmentSection.createEl('div', { cls: 'zotsidian-source-subtitle', text: 'Attachments' });

    if (attachmentRows.length === 0) {
      attachmentSection.createEl('div', { cls: 'zotsidian-source-empty', text: 'No attachment metadata available.' });
    } else {
      for (const row of attachmentRows) {
        if (!row || typeof row !== 'object' || typeof row.open !== 'string' || row.open.length === 0) continue;
        this.renderAttachmentLink(attachmentSection, row);
      }
    }

    const annotationSection = containerDiv.createDiv({ cls: 'zotsidian-source-annotations' });
    annotationSection.createEl('div', { cls: 'zotsidian-source-subtitle', text: 'Annotations' });

    if (attachmentRows.length === 0) {
      annotationSection.createEl('div', {
        cls: 'zotsidian-source-empty',
        text: 'Annotations are unavailable because no attachments were found for this source.',
      });
      return;
    }

    const groups = attachmentRows.filter((row) => Array.isArray(row.annotations) && row.annotations.length > 0);
    if (groups.length === 0) {
      annotationSection.createEl('div', {
        cls: 'zotsidian-source-empty',
        text: 'No annotations were returned for these attachments.',
      });
      return;
    }

    for (const row of groups) {
      const group = annotationSection.createDiv({ cls: 'zotsidian-source-annotation-group' });
      const groupHeader = group.createDiv({ cls: 'zotsidian-source-annotation-group-header' });
      const groupLink = groupHeader.createEl('a', {
        href: row.open || '#',
        text: typeof row.label === 'string' && row.label.trim().length > 0 ? row.label.trim() : 'Attachment',
      });
      if (typeof row.open === 'string' && row.open.startsWith('http')) {
        groupLink.setAttribute('target', '_blank');
        groupLink.setAttribute('rel', 'noopener noreferrer');
      }
      groupLink.addEventListener('click', (evt) => {
        evt.preventDefault();
        if (row.open) {
          this.openLinkTarget(row.open);
        }
      });

      const count = row.annotations?.length || 0;
      groupHeader.createSpan({
        cls: 'zotsidian-source-annotation-group-count',
        text: `${count} annotation${count === 1 ? '' : 's'}`,
      });

      const list = group.createDiv({ cls: 'zotsidian-source-annotation-list' });
      for (const annotation of row.annotations || []) {
        this.renderAnnotationCard(list, annotation, row.open);
      }
    }
  }

  private async resolvePreferredItemLink(citekey: string, itemData: Record<string, unknown>, scope: string): Promise<string> {
    const hint = {
      itemKey: this.parseItemKey(itemData),
      zoteroItemID: (typeof itemData['zoteroItemID'] === 'string' ? itemData['zoteroItemID'] : undefined) as string | undefined,
      zotero: (typeof itemData['zotero'] === 'string' ? itemData['zotero'] : undefined) as string | undefined,
      citekey: (typeof itemData['id'] === 'string' ? itemData['id'] : citekey) as string | undefined,
      doi: (typeof itemData['DOI'] === 'string' ? itemData['DOI'] : undefined) as string | undefined,
      title: (typeof itemData['title'] === 'string' ? itemData['title'] : undefined) as string | undefined,
    };
    try {
      const rows = await attachments(citekey, scope.split('/')[0] || scope, hint);
      const attachmentRows = Array.isArray(rows) ? rows : [];
      const preferred = attachmentRows.find((row: any) => typeof row?.open === 'string' && row.open.startsWith('zotero://open-pdf/'))
        || attachmentRows.find((row: any) => typeof row?.open === 'string' && row.open.length > 0);
      if (preferred?.open) {
        return preferred.open;
      }
    } catch (_err) {
      // Fall through to item/web link.
    }
    return this.zoteroUriFromItemData(itemData)
      || (typeof itemData['URL'] === 'string' ? itemData['URL'] as string : '')
      || '';
  }

  private wirePreferredItemLink(linkEl: HTMLAnchorElement, citekey: string, itemData: Record<string, unknown>, scope: string) {
    const defaultLink = this.zoteroUriFromItemData(itemData)
      || (typeof itemData['URL'] === 'string' ? itemData['URL'] as string : '')
      || '#';
    linkEl.setAttribute('href', defaultLink);
    if (defaultLink.startsWith('http')) {
      linkEl.setAttribute('target', '_blank');
      linkEl.setAttribute('rel', 'noopener noreferrer');
    }
    linkEl.addEventListener('click', async (evt) => {
      evt.preventDefault();
      const preferred = await this.resolvePreferredItemLink(citekey, itemData, scope);
      this.openLinkTarget(preferred || defaultLink);
    });
  }

  private summarizeAuthors(authors: string[]): string {
    if (!Array.isArray(authors) || authors.length === 0) return '';
    if (authors.length === 1) return authors[0];
    if (authors.length === 2) return `${authors[0]} & ${authors[1]}`;
    return `${authors[0]} et al.`;
  }

  private connectedPapersUrl(doi: string, title: string): string {
    return doi
      ? `https://www.connectedpapers.com/api/redirect/doi/${encodeURIComponent(doi)}`
      : (title ? `https://www.connectedpapers.com/search?q=${encodeURIComponent(title)}` : '');
  }

  private googleScholarUrl(doi: string, title: string): string {
    return doi
      ? `https://scholar.google.com/scholar?q=${encodeURIComponent(doi)}`
      : (title ? `https://scholar.google.com/scholar?q=${encodeURIComponent(title)}` : '');
  }

  private semanticScholarUrl(doi: string, title: string): string {
    return doi
      ? `https://www.semanticscholar.org/search?q=${encodeURIComponent(doi)}`
      : (title ? `https://www.semanticscholar.org/search?q=${encodeURIComponent(title)}` : '');
  }

  private renderRelatedLibraryItems(containerDiv: HTMLElement, items: SourceRelatedLibraryItem[], scope: string) {
    const list = containerDiv.createDiv({ cls: 'zotsidian-related-library-items' });
    const sortedItems = [...items].sort((a, b) => {
      const aScore = (a.relations.includes('reference') ? 1 : 0) + (a.relations.includes('citation') ? 2 : 0);
      const bScore = (b.relations.includes('reference') ? 1 : 0) + (b.relations.includes('citation') ? 2 : 0);
      return bScore - aScore || a.citekey.localeCompare(b.citekey);
    });
    for (const item of sortedItems) {
      const row = list.createDiv({ cls: 'zotsidian-related-library-item' });
      const left = row.createDiv({ cls: 'zotsidian-related-library-main' });
      const badgeWrap = left.createDiv({ cls: 'zotsidian-related-library-relations' });
      if (item.relations.includes('reference')) {
        badgeWrap.createSpan({ cls: 'zotsidian-related-library-badge is-reference', text: 'Reference' });
      }
      if (item.relations.includes('citation')) {
        badgeWrap.createSpan({ cls: 'zotsidian-related-library-badge is-citation', text: 'Citation' });
      }
      const titleLink = left.createEl('a', { cls: 'zotsidian-related-library-title', text: item.title });
      this.wirePreferredItemLink(titleLink, item.citekey, item.raw, scope);
      left.createEl('div', {
        cls: 'zotsidian-related-library-meta',
        text: item.meta || item.relations.map((relation) => relation === 'reference' ? 'Reference' : 'Citation').join(' · '),
      });
      const right = row.createDiv({ cls: 'zotsidian-related-library-side' });
      const citekeyLink = right.createEl('a', { cls: 'zotsidian-related-library-citekey', text: `@${item.citekey}` });
      this.wireSourcePageLink(citekeyLink, item.citekey, item.title, item.raw);
    }
    return list;
  }

  private renderSourceRelatedNote(section: HTMLElement, note: string) {
    if (!note || !note.trim()) return;
    section.createDiv({
      cls: 'zotsidian-source-related-note',
      text: note.trim(),
    });
  }

  private renderSourceRelatedSection(containerDiv: HTMLElement, related: SourceRelatedData, scope: string) {
    const section = containerDiv.createDiv({ cls: 'zotsidian-source-related' });
    const divider = section.createDiv({ cls: 'zotsidian-source-related-divider' });
    void divider;

    const bar = section.createDiv({ cls: 'zotsidian-source-related-bar' });
    const refButton = bar.createEl('button', {
      cls: 'zotsidian-source-related-button zotsidian-source-related-button-reference',
      text: `${related.referenceCount} references`,
    });
    refButton.disabled = related.references.length === 0;
    refButton.onclick = () => {
      new SourceRelatedModal(this.app, this.plugin, scope, related.title, 'references', related.references).open();
    };

    const citationButton = bar.createEl('button', {
      cls: 'zotsidian-source-related-button zotsidian-source-related-button-citation',
      text: `${related.citationCount} citations`,
    });
    citationButton.disabled = related.citations.length === 0;
    citationButton.onclick = () => {
      new SourceRelatedModal(this.app, this.plugin, scope, related.title, 'citations', related.citations).open();
    };

    const relatedButton = bar.createEl('button', {
      cls: 'zotsidian-source-related-button zotsidian-source-related-button-library',
      text: `${related.relatedLibraryItems.length} related library items`,
    });
    relatedButton.disabled = related.relatedLibraryItems.length === 0;

    const libraryWrap = section.createDiv({ cls: 'zotsidian-related-library-wrap' });
    libraryWrap.style.display = 'none';
    if (related.relatedLibraryItems.length > 0) {
      this.renderRelatedLibraryItems(libraryWrap, related.relatedLibraryItems, scope);
      relatedButton.onclick = () => {
        libraryWrap.style.display = libraryWrap.style.display === 'none' ? 'block' : 'none';
      };
    }

    this.renderSourceRelatedNote(section, related.note);
  }

  private getReferenceDisplayData(itemData: Record<string, unknown>) {
    const title = typeof itemData['title'] === 'string' ? itemData['title'] : '(metadata unavailable)';
    const journalShort = typeof itemData['container-title-short'] === 'string' ? itemData['container-title-short'] : '';
    const journalFull = typeof itemData['container-title'] === 'string' ? itemData['container-title'] : '';
    const journal = journalShort !== '' ? journalShort : journalFull;

    let issueDate = '';
    try {
      const issued = itemData['issued'] as Record<string, unknown> | undefined;
      if (issued && 'date-parts' in issued) {
        const dateParts = issued['date-parts'] as unknown[];
        if (Array.isArray(dateParts) && Array.isArray(dateParts[0])) {
          issueDate = (dateParts[0] as unknown[])[0] != undefined ? String((dateParts[0] as unknown[])[0]) : '';
        }
      } else if (issued && typeof issued['literal'] === 'string') {
        issueDate = issued['literal'].split(" ")[0];
      }
    } catch {
      issueDate = '';
    }

    return { title, journal, issueDate };
  }

  private renderReferenceRow(containerDiv: HTMLElement, citekey: string, itemData: Record<string, unknown>, scope: string) {
    const { title, journal, issueDate } = this.getReferenceDisplayData(itemData);
    const itemDiv = containerDiv.createDiv({ cls: 'reference-div' });
    this.attachReferenceHover(itemDiv, citekey);
    const citekeyDiv = itemDiv.createDiv({ cls: "reference-citekey", attr: { 'data-citekey': citekey } });
    const citekeyLink = citekeyDiv.createEl('a', { text: `@${citekey}` });
    this.wireSourcePageLink(citekeyLink, citekey, title, itemData);
    const titleLink = itemDiv.createDiv({ cls: "reference-title" }).createEl('a', { text: title });
    this.wirePreferredItemLink(titleLink, citekey, itemData, scope);
    itemDiv.createDiv({ cls: "reference-journal", text: `${journal}${journal && issueDate ? ' ' : ''}${issueDate}`.trim() });
  }

  private renderInlineReferencesSection(containerDiv: HTMLElement, refs: CollectionData | undefined, excludedCitekey?: string) {
    const section = containerDiv.createDiv({ cls: 'zotsidian-source-inline-references-section' });
    section.createEl('div', { cls: 'zotsidian-source-subtitle', text: 'References' });

    const list = section.createDiv({ cls: 'zotsidian-references-div zotsidian-source-inline-references' });
    const citations = this.sortCitations((refs?.citations || []).filter((citekey) => citekey !== excludedCitekey), refs);

    if (citations.length === 0) {
      list.createDiv({ cls: 'zotsidian-source-empty', text: 'No inline citations in this source page.' });
      return;
    }

    for (const citekey of citations) {
      const itemData = (refs?.data.get(citekey) || {}) as Record<string, unknown>;
      this.renderReferenceRow(list, citekey, itemData, refs?.path || this.plugin.settings.defaultZoteroScope);
    }
  }

  setHeader(header: HTMLElement, scope?: string, detectedMentions: number = 0){
    header.createEl("span", { text: 'References', cls: "references-header-text" });
    this._statusEl = header.createDiv({ cls: 'zotsidian-status-pill is-hidden' });
    const refreshButton = header.createEl("button", {cls: "refresh-button" , title: "Refresh"});
    this._refreshButtonEl = refreshButton;
    setIcon(refreshButton, "refresh-cw");

    const searchButton = header.createEl("button", {cls: "search-button", title: "Search Zotero library"});
    setIcon(searchButton, "search");
    this.addSortMenuButton(header);

    searchButton.onclick = () => {
      const collectionPath = this.activeFileCollectionData?.path || this.plugin.resolveScopeFromFrontmatter(undefined);
      this.plugin.openSearchPanel(collectionPath);
    };
    refreshButton.onclick = async () => {
      await this.refreshReferences();
      await this.renderReferences();
    };

    this._headerScope = scope || this.plugin.getActiveScope();
    this._headerDetectedMentions = detectedMentions;
    this.refreshHeaderStatus();

  }

  setViewContent(content: HTMLElement, scope?: string, detectedMentions: number = 0) {
    this.hideReferenceHoverCard();
    this.contentEl.empty();
    const containerDiv = this.contentEl.createDiv({cls:"zotsidian-container-div" });
    const header = containerDiv.createDiv({cls:"references-header"});

    this.setHeader(header, scope, detectedMentions);

    if (!content) {
      this.setEmptyView();
    } else {
      containerDiv.appendChild(content);
    }
  }

  setErrorView(error?: Error, scope?: string, detectedMentions: number = 0) {
    this.hideReferenceHoverCard();
    
    this.contentEl.empty();
    
    const containerDiv = this.contentEl.createDiv({cls:"zotsidian-container-div" });
    
    const header = containerDiv.createDiv({cls:"references-header"});
    this.setHeader(header, scope, detectedMentions);

    const status = this.plugin.getCitationIndexStatus(scope);
    const message = error?.message === 'net::ERR_CONNECTION_REFUSED'
      ? 'Unable to connect to Zotero. Is Zotero running?'
      : (status.errorText || error?.message || 'Unknown references error.');
    containerDiv.createDiv({
      cls: 'pane-empty',
      text: message,
    });
  }

  setEmptyView(scope?: string, detectedMentions: number = 0, message: string = 'No citations found in the current document.') {
    this.hideReferenceHoverCard();
    this.contentEl.empty();
    const containerDiv = this.contentEl.createDiv({cls:"zotsidian-container-div" });
    const header = containerDiv.createDiv({cls:"references-header"});

    this.setHeader(header, scope, detectedMentions);
    containerDiv.createDiv({
      cls: 'pane-empty',
      text: message,
    });

  }

  setLoadingView(scope?: string, detectedMentions: number = 0) {
    this.hideReferenceHoverCard();

    this.contentEl.empty();
    const containerDiv = this.contentEl.createDiv({cls:"zotsidian-container-div" });
    const header = containerDiv.createDiv({cls:"references-header"});

    this.setHeader(header, scope, detectedMentions);

    //emptyDiv with loading spinner
    const empty = containerDiv.createDiv({ cls: 'pane-empty' });
    empty.createEl("span", {cls: "loader-spinner"});

    


  }

  getViewType() {
    return ReferencesViewType;
  }

  getDisplayText() {
    return 'References';
  }

  getIcon() {
    return 'graduation-cap';
  }

  async refresh(){

    await this.refreshReferences();

  }

  async refreshReferences() {

    let refs;

		const activeFile = this.plugin.app.workspace.getActiveFile();

		if (activeFile) {

			try {
        const collectionDataForFile = await this.buildCollectionDataForFile(activeFile);
        this._fileCollectionData.set(activeFile.path, collectionDataForFile);
        return collectionDataForFile;

			} catch (e) {
				console.error(e);
				refs = this.emptyCollectionData();
        refs.error = e;
        return refs;
			}

		}
    return this.emptyCollectionData();

	};

  async processReferences() {

    let refs;

		const activeFile = this.plugin.app.workspace.getActiveFile();

		if (activeFile) {

			try {

        let collectionDataForFile:CollectionData | undefined

        collectionDataForFile = this._fileCollectionData.get(activeFile.path)

        if (collectionDataForFile){
          return collectionDataForFile;
        }

        collectionDataForFile = await this.buildCollectionDataForFile(activeFile);

        this._fileCollectionData.set(activeFile.path, collectionDataForFile)

        return collectionDataForFile;

			} catch (e) {
				console.error(e);
				refs = this.emptyCollectionData();
        refs.error = e;
        return refs;
			}

		} else {
			refs = this.emptyCollectionData();
      return refs;

		};

	};

  async renderReferences() {
    const activeFile = this.plugin.app.workspace.getActiveFile();
    const activeCache = activeFile ? this.plugin.app.metadataCache.getFileCache(activeFile) : null;
    const activeScope = this.plugin.resolveScopeFromFrontmatter(activeCache?.frontmatter as Record<string, unknown> | undefined);
    this.setLoadingView(activeScope);

    const sourceCitekey = this.getActiveSourceCitekey();
    if (sourceCitekey) {
      const refs = await this.processReferences();
      await this.renderSourceInspector(sourceCitekey, refs);
      return;
    }

    const refs = await this.processReferences();
    
    if (!refs.citations || refs.citations.length ==0){
      if ('error' in refs) {
        this.setErrorView(refs.error, refs.path, refs.detectedCitations?.length || 0);
      } else if ((refs.detectedCitations?.length || 0) > 0) {
        const status = this.plugin.getCitationIndexStatus(refs.path);
        let message = 'Citations were detected, but none could be resolved in the current scope.';
        if (status.loading) {
          message = 'Citations were detected, but the Zotero index is still loading.';
        } else if (status.connection === 'disconnected') {
          message = status.errorText || 'Citations were detected, but Zotsidian cannot reach Zotero.';
        } else if (status.connection === 'degraded') {
          message = status.errorText || 'Citations were detected, but metadata could not be resolved from the current scope.';
        }
        this.setEmptyView(refs.path, refs.detectedCitations?.length || 0, message);
      } else {
        this.setEmptyView(refs.path, 0);
      };
      return
    }

    const containerDiv = document.createElement('div');
    containerDiv.classList.add('zotsidian-references-div');
    
    for (const item of this.sortCitations(refs.citations || [], refs)) {

      const itemData = (refs.data.get(item) || {}) as Record<string, unknown>;
      const citekey = typeof itemData['id'] === 'string' && itemData['id'] ? itemData['id'] : item;
      this.renderReferenceRow(containerDiv, citekey, itemData, refs.path);
    }
  

    this.setViewContent(containerDiv, refs.path, refs.detectedCitations?.length || refs.citations.length);

    if (this.plugin.settings.enableSidebarAttachments) {
      await this.renderAttachments(refs);
    }

  };

  async renderAttachments(collectionData:CollectionData) {
    void collectionData;
    return;
  };

  async onClose() {
    this.hideReferenceHoverCard();
  }

}


type SourceRelatedModalMode = 'references' | 'citations';

class SourceRelatedModal extends Modal {
  private readonly mode: SourceRelatedModalMode;
  private readonly items: SourceRelatedEntry[];
  private readonly panelTitle: string;
  private readonly collectionPath: string;

  constructor(app: App, private plugin: ZotsidianPlugin, scope: string, sourceTitle: string, mode: SourceRelatedModalMode, items: SourceRelatedEntry[]) {
    super(app);
    this.plugin = plugin;
    this.collectionPath = scope;
    this.mode = mode;
    this.items = [...items].sort((a, b) => (a.year || 0) - (b.year || 0) || a.title.localeCompare(b.title));
    this.panelTitle = sourceTitle;
  }

  private summarizeAuthors(authors: string[]): string {
    if (!Array.isArray(authors) || authors.length === 0) return '';
    if (authors.length === 1) return authors[0];
    if (authors.length === 2) return `${authors[0]} & ${authors[1]}`;
    return `${authors[0]} et al.`;
  }

  private wireSourcePageLink(linkEl: HTMLAnchorElement, entry: SourceRelatedMatch) {
    linkEl.setAttribute('href', entry.sourceNotePath || '#');
    linkEl.addClass(entry.sourceNotePath ? 'has-source-page' : 'is-missing-source-page');
    linkEl.setAttribute('title', entry.sourceNotePath ? 'Open existing source page' : 'Create source page');
    linkEl.addEventListener('click', async (evt) => {
      evt.preventDefault();
      await this.plugin.openOrCreateSourcePage(entry.citekey, entry.title, entry.raw);
    });
  }

  private addExternalLink(container: HTMLElement, href: string, text: string) {
    if (!href) return;
    const link = container.createEl('a', { text, href });
    link.setAttribute('target', '_blank');
    link.setAttribute('rel', 'noopener noreferrer');
  }

  private semanticUrl(item: SourceRelatedEntry): string {
    if (item.url) return item.url;
    if (item.doi) return `https://www.semanticscholar.org/search?q=${encodeURIComponent(item.doi)}`;
    return item.title ? `https://www.semanticscholar.org/search?q=${encodeURIComponent(item.title)}` : '';
  }

  private connectedPapersUrl(item: SourceRelatedEntry): string {
    if (item.doi) return `https://www.connectedpapers.com/api/redirect/doi/${encodeURIComponent(item.doi)}`;
    return item.title ? `https://www.connectedpapers.com/search?q=${encodeURIComponent(item.title)}` : '';
  }

  private googleScholarUrl(item: SourceRelatedEntry): string {
    if (item.doi) return `https://scholar.google.com/scholar?q=${encodeURIComponent(item.doi)}`;
    return item.title ? `https://scholar.google.com/scholar?q=${encodeURIComponent(item.title)}` : '';
  }

  private zoteroUriFromItemData(itemData: Record<string, unknown>): string {
    const explicitZotero = typeof itemData['zotero'] === 'string' ? itemData['zotero'] : '';
    if (explicitZotero.startsWith('zotero://')) {
      return explicitZotero;
    }

    const itemId = typeof itemData['zoteroItemID'] === 'string' ? itemData['zoteroItemID'] : '';
    if (itemId) {
      if (itemId.startsWith('zotero://')) {
        return itemId;
      }
      const groupMatch = itemId.match(/\/groups\/([0-9]+)\/items\/([A-Z0-9]{8})/i);
      if (groupMatch?.[1] && groupMatch?.[2]) {
        return `zotero://select/groups/${groupMatch[1]}/items/${groupMatch[2]}`;
      }
      const userMatch = itemId.match(/\/users\/([0-9]+)\/items\/([A-Z0-9]{8})/i);
      if (userMatch?.[2]) {
        return `zotero://select/library/items/${userMatch[2]}`;
      }
    }

    const itemKey = typeof itemData['itemKey'] === 'string' && itemData['itemKey']
      ? itemData['itemKey'] as string
      : (typeof itemData['zotero-key'] === 'string' ? itemData['zotero-key'] as string : '');
    if (itemKey) {
      return `zotero://select/library/items/${itemKey}`;
    }

    const webUrl = typeof itemData['URL'] === 'string' && itemData['URL']
      ? itemData['URL'] as string
      : (typeof itemData['id'] === 'string' && String(itemData['id']).startsWith('http') ? String(itemData['id']) : '');
    return webUrl || '';
  }

  private openExternalUrl(url: string) {
    if (!url) return;
    const link = document.createElement('a');
    link.href = url;
    if (url.startsWith('http')) {
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
    }
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  private async resolveLocalPreferredUrl(item: SourceRelatedEntry): Promise<string> {
    if (!item.localMatch) {
      return this.semanticUrl(item);
    }
    const raw = item.localMatch.raw;
    const hint = {
      itemKey: typeof raw.itemKey === 'string' ? raw.itemKey : (typeof raw['zotero-key'] === 'string' ? raw['zotero-key'] : undefined),
      zoteroItemID: typeof raw.zoteroItemID === 'string' ? raw.zoteroItemID : undefined,
      zotero: typeof raw.zotero === 'string' ? raw.zotero : undefined,
      citekey: item.localMatch.citekey,
      doi: typeof raw.DOI === 'string' ? raw.DOI : item.doi || undefined,
      title: typeof raw.title === 'string' ? raw.title : item.title,
    };
    try {
      const rows = await attachments(item.localMatch.citekey, this.collectionPath.split('/')[0] || this.collectionPath, hint);
      const attachmentRows = Array.isArray(rows) ? rows : [];
      const preferred = attachmentRows.find((row: any) => typeof row?.open === 'string' && row.open.startsWith('zotero://open-pdf/'))
        || attachmentRows.find((row: any) => typeof row?.open === 'string' && row.open.length > 0);
      if (preferred?.open) {
        return preferred.open;
      }
    } catch (_err) {
      // Fall through to item link.
    }
    return this.zoteroUriFromItemData(raw) || this.semanticUrl(item);
  }

  onOpen() {
    const { contentEl, titleEl } = this;
    this.modalEl.addClass('zotsidian-related-modal-shell');
    titleEl.setText(`${this.mode === 'references' ? 'References' : 'Citations'} · ${this.panelTitle}`);
    contentEl.empty();
    contentEl.addClass('zotsidian-related-modal');

    const list = contentEl.createDiv({ cls: 'zotsidian-related-modal-list' });
    for (const item of this.items) {
      const row = list.createDiv({ cls: 'zotsidian-related-modal-item' });
      row.createDiv({ cls: 'zotsidian-related-modal-year', text: item.year == null ? '' : String(item.year) });
      const main = row.createDiv({ cls: 'zotsidian-related-modal-main' });
      const externalUrl = this.semanticUrl(item);
      const localUrl = item.localMatch ? this.zoteroUriFromItemData(item.localMatch.raw) : '';
      const titleHref = item.localMatch ? (localUrl || externalUrl || '#') : (externalUrl || '#');
      const titleLink = main.createEl('a', { cls: 'zotsidian-related-modal-title', text: item.title, href: titleHref });
      if (titleHref) {
        if (titleHref.startsWith('http')) {
          titleLink.setAttribute('target', '_blank');
          titleLink.setAttribute('rel', 'noopener noreferrer');
        }
      } else {
        titleLink.addClass('is-disabled');
      }
      if (item.localMatch) {
        titleLink.addEventListener('click', async (evt) => {
          evt.preventDefault();
          const resolvedUrl = await this.resolveLocalPreferredUrl(item);
          this.openExternalUrl(resolvedUrl);
        });
      }
      const metaParts = [
        this.summarizeAuthors(item.authors),
        item.venue,
        item.year == null ? '' : String(item.year),
      ].filter((part) => part.length > 0);
      if (metaParts.length > 0) {
        main.createDiv({ cls: 'zotsidian-related-modal-meta', text: metaParts.join(' · ') });
      }
      const actions = main.createDiv({ cls: 'zotsidian-related-modal-actions' });
      this.addExternalLink(actions, externalUrl, 'Semantic Scholar');
      this.addExternalLink(actions, this.connectedPapersUrl(item), 'Connected Papers');
      this.addExternalLink(actions, this.googleScholarUrl(item), 'Google Scholar');

      const side = row.createDiv({ cls: 'zotsidian-related-modal-side' });
      if (item.localMatch) {
        const local = side.createEl('a', { cls: 'zotsidian-related-modal-citekey', text: `@${item.localMatch.citekey}` });
        this.wireSourcePageLink(local, item.localMatch);
      }
    }
  }

  onClose() {
    this.modalEl.removeClass('zotsidian-related-modal-shell');
    this.contentEl.empty();
  }
}
