
import { promises as fs } from 'fs';
import { App, ItemView, WorkspaceLeaf, Modal, Menu, Notice, setIcon, TFile, MarkdownView } from 'obsidian';

import ZotsidianPlugin, { type AnnotationImageCopyFormat, type AnnotationTextCopyFormat, type DiscourseNodeSidebarItem, type PinnedDiscourseNodeItem, type ReferenceLocateTarget, type RelatedDiscourseNodeSidebarItem, type SourceRelatedData, type SourceRelatedEntry, type SourceRelatedLibraryItem, type SourceRelatedMatch } from 'main';
import { createCitationHoverCardElement } from 'EditorExtensions';
import { buildAnnotationInsertTemplateContext, getBuiltInAnnotationTemplate, normalizeAnnotationTemplatePreset, renderAnnotationInsertPayload } from 'AnnotationTemplate';
import type { TemplateRenderContext } from 'TemplateBackend';
import { getConfiguredTemplatePath } from 'TemplateRegistry';

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
  annotationTags?: string[];
  annotationPageLabel?: string;
  annotationPosition?: unknown;
  annotationSortIndex?: string;
  annotationText?: string;
  annotationImagePath?: string;
  annotationAuthorName?: string;
  dateAdded?: string;
  dateModified?: string;
  openHref?: string;
};

type SidebarAttachmentRow = {
  open?: string;
  path?: boolean;
  label?: string;
  annotations?: SidebarAnnotation[];
};

type DraggableDiscourseNodeItem = DiscourseNodeSidebarItem | PinnedDiscourseNodeItem;

type AnnotationImageCacheEntry = {
  value?: string;
  pending?: Promise<string>;
  failed?: boolean;
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
  private _annotationImageSrcCache: Map<string, AnnotationImageCacheEntry>;
  private _statusEl: HTMLElement | null;
  private _refreshButtonEl: HTMLButtonElement | null;
  private _headerScope: string | null;
  private _headerDetectedMentions: number;
  private _lastRenderedFilePath: string | null;
  private _lastRenderedMode: 'references' | 'source' | 'empty' | 'error' | null;
  private _sourceAttachmentCache: Map<string, { rows: SidebarAttachmentRow[]; fetchedAt: number }>;
  private _sourceAnnotationsOpenByFile: Map<string, boolean>;
  private _sourceAnnotationTypeFilterByFile: Map<string, string>;
  private _sourceAnnotationColorFilterByFile: Map<string, string>;
  private _sourceAnnotationTagFilterByFile: Map<string, string>;
  private _sidebarSectionOpenState: Map<string, boolean>;

  constructor(leaf: WorkspaceLeaf, plugin: ZotsidianPlugin) {
    super(leaf);
    this.plugin = plugin;
    this._fileCollectionData = new Map()
    this._referenceSortMode = 'insertion';
    this._hoverCardEl = null;
    this._hoverTargetEl = null;
    this._hoverHideTimer = null;
    this._hoverSwitchTimer = null;
    this._annotationImageSrcCache = new Map();
    this._statusEl = null;
    this._refreshButtonEl = null;
    this._headerScope = null;
    this._headerDetectedMentions = 0;
    this._lastRenderedFilePath = null;
    this._lastRenderedMode = null;
    this._sourceAttachmentCache = new Map();
    this._sourceAnnotationsOpenByFile = new Map();
    this._sourceAnnotationTypeFilterByFile = new Map();
    this._sourceAnnotationColorFilterByFile = new Map();
    this._sourceAnnotationTagFilterByFile = new Map();
    this._sidebarSectionOpenState = new Map();
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

  private getAnnotationTagLabels(annotation: SidebarAnnotation): string[] {
    const tags = Array.isArray(annotation.annotationTags) ? annotation.annotationTags : [];
    const seen = new Set<string>();
    const labels: string[] = [];
    for (const tag of tags) {
      const label = typeof tag === 'string' ? tag.trim() : '';
      if (!label || seen.has(label.toLowerCase())) continue;
      seen.add(label.toLowerCase());
      labels.push(label);
    }
    return labels;
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

  private resolveAnnotationCopyText(annotation: SidebarAnnotation): string {
    const text = typeof annotation.annotationText === 'string' ? annotation.annotationText.trim() : '';
    const comment = typeof annotation.annotationComment === 'string' ? annotation.annotationComment.trim() : '';
    if (text && comment) {
      return `${text}\n\n${comment}`;
    }
    return text || comment || '';
  }

  private buildAnnotationOpenAnchor(annotation: SidebarAnnotation, openHref?: string): string {
    const key = (annotation.key || '').trim().toUpperCase();
    const href = (openHref || annotation.openHref || '').trim();
    if (!key && !href) return '';
    if (!href) return `Open in Zotero${key ? ` · ${key}` : ''}`;
    return `[Open in Zotero${key ? ` · ${key}` : ''}](${href})`;
  }

  private async buildAnnotationCopyPayload(
    annotation: SidebarAnnotation,
    openHref: string | undefined,
    format: AnnotationTextCopyFormat | Exclude<AnnotationImageCopyFormat, 'image'>
  ): Promise<string> {
    if (format === 'plain') return this.resolveAnnotationCopyText(annotation);
    if (format === 'current-template') return this.buildAnnotationInsertPayload(annotation, openHref);
    const type = (annotation.annotationType || '').trim().toLowerCase();
    const kind: 'text' | 'image' = type === 'image' ? 'image' : 'text';
    if (format === 'callout') {
      const template = getBuiltInAnnotationTemplate('callout', kind);
      return renderAnnotationInsertPayload(template, {
        ...annotation,
        openHref,
        localImagePath: this.resolveAnnotationLocalImagePath(annotation),
        localImageEmbed: this.resolveAnnotationLocalImagePath(annotation)
          ? this.buildLocalImageEmbed(this.resolveAnnotationLocalImagePath(annotation))
          : '',
        formattedDate: this.formatAnnotationDate(annotation.dateModified || annotation.dateAdded),
      }).trim();
    }
    const markdown = await this.buildAnnotationInsertPayload(annotation, openHref);
    if (format === 'markdown-link') {
      return [this.buildAnnotationOpenAnchor(annotation, openHref), markdown].filter(Boolean).join('\n').trim();
    }
    return markdown;
  }

  private async copyAnnotation(
    annotation: SidebarAnnotation,
    openHref?: string,
    format?: AnnotationTextCopyFormat | Exclude<AnnotationImageCopyFormat, 'image'>
  ) {
    const resolvedFormat = format || this.plugin.settings.annotationTextCopyDefault || 'markdown-link';
    const payload = await this.buildAnnotationCopyPayload(annotation, openHref, resolvedFormat);
    if (!payload) {
      new Notice('No annotation text or comment available to copy.');
      return;
    }
    try {
      await navigator.clipboard.writeText(payload);
      new Notice('Annotation copied.');
    } catch (_err) {
      new Notice('Unable to copy annotation.');
    }
  }

  private async copyAnnotationImage(annotation: SidebarAnnotation): Promise<boolean> {
    const imageSrc = await this.loadAnnotationImageSrc(annotation);
    if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) return false;
    try {
      let blob: Blob | null = null;
      let mime = 'image/png';
      if (imageSrc.startsWith('data:image/')) {
        const [header, encoded] = imageSrc.split(',', 2);
        const mimeMatch = header.match(/^data:(.*?);base64$/i);
        mime = mimeMatch?.[1] || 'image/png';
        const bytes = Uint8Array.from(Buffer.from(encoded || '', 'base64'));
        blob = new Blob([bytes], { type: mime });
      } else if (/^(blob:|https?:|file:)/i.test(imageSrc)) {
        const response = await fetch(imageSrc);
        if (!response.ok) return false;
        blob = await response.blob();
        mime = blob.type || mime;
      }
      if (!blob) return false;
      await navigator.clipboard.write([new ClipboardItem({ [mime]: blob })]);
      new Notice('Annotation image copied.');
      return true;
    } catch (_err) {
      return false;
    }
  }

  private async copyAnnotationImageMarkdown(annotation: SidebarAnnotation): Promise<boolean> {
    const localPath = this.resolveAnnotationLocalImagePath(annotation);
    const markdown = localPath ? this.buildLocalImageEmbed(localPath) : '';
    if (!markdown) return false;
    try {
      await navigator.clipboard.writeText(markdown);
      new Notice('Annotation image Markdown copied.');
      return true;
    } catch (_err) {
      return false;
    }
  }

  private async copyAnnotationImageDefault(annotation: SidebarAnnotation, openHref?: string): Promise<void> {
    const format = this.plugin.settings.annotationImageCopyDefault || 'image';
    if (format === 'image') {
      const copiedImage = await this.copyAnnotationImage(annotation);
      if (copiedImage) return;
      await this.copyAnnotation(annotation, openHref, 'markdown-link');
      return;
    }
    if (format === 'image-markdown') {
      const copied = await this.copyAnnotationImageMarkdown(annotation);
      if (!copied) await this.copyAnnotation(annotation, openHref, 'markdown-link');
      return;
    }
    await this.copyAnnotation(annotation, openHref, format);
  }

  private showAnnotationCopyMenu(annotation: SidebarAnnotation, evt: MouseEvent, openHref?: string) {
    const isImageAnnotation = (annotation.annotationType || '').trim().toLowerCase() === 'image';
    const menu = new Menu();
    if (isImageAnnotation) {
      menu.addItem((item) => {
        item
          .setTitle('Copy image')
          .setIcon('image')
          .onClick(async () => {
            const copied = await this.copyAnnotationImage(annotation);
            if (!copied) new Notice('Unable to copy annotation image.');
          });
      });
      menu.addItem((item) => {
        item
          .setTitle('Copy image Markdown')
          .setIcon('copy')
          .onClick(async () => {
            const copied = await this.copyAnnotationImageMarkdown(annotation);
            if (!copied) new Notice('Unable to copy image Markdown.');
          });
      });
    }
    menu.addItem((item) => {
      item
        .setTitle('Copy Markdown + Zotero link')
        .setIcon('link')
        .onClick(() => void this.copyAnnotation(annotation, openHref, 'markdown-link'));
    });
    menu.addItem((item) => {
      item
        .setTitle('Copy Markdown')
        .setIcon('text')
        .onClick(() => void this.copyAnnotation(annotation, openHref, 'markdown'));
    });
    menu.addItem((item) => {
      item
        .setTitle('Copy callout')
        .setIcon('quote')
        .onClick(() => void this.copyAnnotation(annotation, openHref, 'callout'));
    });
    if (!isImageAnnotation) {
      menu.addItem((item) => {
        item
          .setTitle('Copy plain text')
          .setIcon('pilcrow')
          .onClick(() => void this.copyAnnotation(annotation, openHref, 'plain'));
      });
    }
    menu.addItem((item) => {
      item
        .setTitle('Copy current insert template')
        .setIcon('file-text')
        .onClick(() => void this.copyAnnotation(annotation, openHref, 'current-template'));
    });
    menu.showAtMouseEvent(evt);
  }

  private resolveAnnotationImageSrc(annotation: SidebarAnnotation): string {
    const raw = typeof annotation.annotationImagePath === 'string' ? annotation.annotationImagePath.trim() : '';
    if (!raw) return '';
    if (/^(data:|blob:|https?:|app:|zotero:)/i.test(raw)) {
      return raw;
    }
    return raw;
  }

  private getAnnotationImageCacheKey(annotation: SidebarAnnotation): string {
    const localPath = this.resolveAnnotationLocalImagePath(annotation);
    if (localPath) return `file:${localPath}`;
    const direct = this.resolveAnnotationImageSrc(annotation);
    if (direct) return `direct:${direct}`;
    return `annotation:${annotation.key}`;
  }

  private getResolvedAnnotationImageSrc(annotation: SidebarAnnotation): string {
    const key = this.getAnnotationImageCacheKey(annotation);
    return this._annotationImageSrcCache.get(key)?.value || '';
  }

  private resolveAnnotationLocalImagePath(annotation: SidebarAnnotation): string {
    const raw = typeof annotation.annotationImagePath === 'string' ? annotation.annotationImagePath.trim() : '';
    if (!raw) return '';
    if (raw.startsWith('file://')) {
      return decodeURIComponent(raw.replace(/^file:\/\//i, ''));
    }
    if (raw.startsWith('/')) {
      return raw;
    }
    return '';
  }

  private buildLocalImageEmbed(localPath: string): string {
    const normalized = localPath.trim();
    if (!normalized) return '';
    return `![](<file://${encodeURI(normalized)}>)`;
  }

  private annotationImageMimeType(localPath: string): string {
    const lower = localPath.toLowerCase();
    if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
    if (lower.endsWith('.webp')) return 'image/webp';
    if (lower.endsWith('.gif')) return 'image/gif';
    if (lower.endsWith('.svg')) return 'image/svg+xml';
    return 'image/png';
  }

  private async loadAnnotationImageSrc(annotation: SidebarAnnotation): Promise<string> {
    const direct = this.resolveAnnotationImageSrc(annotation);
    const localPath = this.resolveAnnotationLocalImagePath(annotation);
    const cacheKey = this.getAnnotationImageCacheKey(annotation);
    const cached = this._annotationImageSrcCache.get(cacheKey);
    if (cached?.value) return cached.value;
    if (cached?.failed) return '';
    if (!localPath) {
      if (direct) {
        this._annotationImageSrcCache.set(cacheKey, { value: direct });
      }
      return direct;
    }
    if (cached?.pending) return await cached.pending;
    const pending = (async () => {
      const file = await fs.readFile(localPath);
      const mime = this.annotationImageMimeType(localPath);
      const blob = new Blob([file], { type: mime });
      const objectUrl = URL.createObjectURL(blob);
      this._annotationImageSrcCache.set(cacheKey, { value: objectUrl });
      return objectUrl;
    })();
    this._annotationImageSrcCache.set(cacheKey, { pending });
    try {
      return await pending;
    } catch (_err) {
      this._annotationImageSrcCache.set(cacheKey, { failed: true });
      return '';
    }
  }

  private mountAnnotationImagePreview(imageWrap: HTMLElement, annotation: SidebarAnnotation, activate: () => void) {
    const renderFallback = () => {
      imageWrap.empty();
      imageWrap.createEl('div', {
        cls: 'zotsidian-source-annotation-image-fallback',
        text: 'Image preview unavailable. Click the card to open the parent item in Zotero.',
      });
    };
    const renderImage = (imageSrc: string) => {
      imageWrap.empty();
      const image = imageWrap.createEl('img', {
        cls: 'zotsidian-source-annotation-image-el',
        attr: { src: imageSrc, alt: 'Zotero image annotation', loading: 'lazy' },
      });
      image.addEventListener('click', (evt) => {
        evt.preventDefault();
        evt.stopPropagation();
        activate();
      });
      image.addEventListener('error', renderFallback, { once: true });
    };

    const cached = this.getResolvedAnnotationImageSrc(annotation);
    if (cached) {
      renderImage(cached);
      return;
    }

    imageWrap.empty();
    imageWrap.createEl('div', {
      cls: 'zotsidian-source-annotation-image-loading',
      text: 'Loading preview…',
    });

    const load = () => {
      void this.loadAnnotationImageSrc(annotation).then((imageSrc) => {
        if (!imageWrap.isConnected) return;
        if (!imageSrc) {
          renderFallback();
          return;
        }
        renderImage(imageSrc);
      });
    };

    const loadIfVisibleNow = () => {
      const wrapRect = imageWrap.getBoundingClientRect();
      const rootRect = this.contentEl.getBoundingClientRect();
      const visible = wrapRect.bottom >= rootRect.top - 160 && wrapRect.top <= rootRect.bottom + 160;
      if (visible) {
        load();
        return true;
      }
      return false;
    };

    if (loadIfVisibleNow()) {
      return;
    }

    if (typeof IntersectionObserver === 'undefined') {
      load();
      return;
    }

    const observer = new IntersectionObserver((entries) => {
      const visible = entries.some((entry) => entry.isIntersecting || entry.intersectionRatio > 0);
      if (!visible) return;
      observer.disconnect();
      load();
    }, {
      root: this.contentEl,
      rootMargin: '160px 0px',
    });
    observer.observe(imageWrap);
  }

  private prefetchVisibleAnnotationImages(annotations: SidebarAnnotation[]) {
    const images = annotations
      .filter((annotation) => (annotation.annotationType || '').trim().toLowerCase() === 'image')
      .slice(0, 4);
    for (const annotation of images) {
      if (this.getResolvedAnnotationImageSrc(annotation)) continue;
      void this.loadAnnotationImageSrc(annotation);
    }
  }

  private hasAnnotationCopyPayload(annotation: SidebarAnnotation): boolean {
    const kind = (annotation.annotationType || '').trim().toLowerCase();
    if (kind === 'image') return true;
    return this.resolveAnnotationCopyText(annotation).length > 0;
  }

  private getSourceAttachmentCacheKey(scope: string, citekey: string): string {
    return `${scope.trim()}::${citekey.trim()}`;
  }

  private getCurrentFilePath(): string {
    return this.plugin.activeFilePath || this.plugin.app.workspace.getActiveFile()?.path || '';
  }

  private getCurrentFile(): TFile | null {
    const path = this.getCurrentFilePath();
    if (path) {
      const abstract = this.plugin.app.vault.getAbstractFileByPath(path);
      if (abstract instanceof TFile) return abstract;
    }
    const active = this.plugin.app.workspace.getActiveFile();
    return active instanceof TFile ? active : null;
  }

  private resolveEffectiveReferenceFile(referenceFilePath?: string): { file: TFile | null; path: string } {
    const normalizedPath = (referenceFilePath || '').trim();
    if (normalizedPath) {
      const abstract = this.plugin.app.vault.getAbstractFileByPath(normalizedPath);
      if (abstract instanceof TFile) {
        return { file: abstract, path: abstract.path };
      }
    }

    const currentFile = this.getCurrentFile();
    if (currentFile instanceof TFile) {
      return { file: currentFile, path: currentFile.path };
    }

    return { file: null, path: normalizedPath };
  }

  private isPlainBaseOrNativeCanvasFile(file: TFile | null | undefined): boolean {
    if (!(file instanceof TFile)) return false;
    if (file.extension === 'base') return true;
    if (file.extension === 'canvas' && !this.plugin.isActiveDiscourseCanvasLeaf()) return true;
    return false;
  }

  private shouldRenderDiscourseGraphPanelForFile(file: TFile | null | undefined): boolean {
    return !this.isPlainBaseOrNativeCanvasFile(file);
  }

  private getStoredAnnotationOpenState(filePath: string): boolean {
    return this._sourceAnnotationsOpenByFile.get(filePath) ?? false;
  }

  private setStoredAnnotationOpenState(filePath: string, open: boolean) {
    if (!filePath) return;
    this._sourceAnnotationsOpenByFile.set(filePath, open);
  }

  private getStoredAnnotationTypeFilter(filePath: string): string {
    return this._sourceAnnotationTypeFilterByFile.get(filePath) ?? 'all';
  }

  private setStoredAnnotationTypeFilter(filePath: string, value: string) {
    if (!filePath) return;
    this._sourceAnnotationTypeFilterByFile.set(filePath, value || 'all');
  }

  private getStoredAnnotationColorFilter(filePath: string): string {
    return this._sourceAnnotationColorFilterByFile.get(filePath) ?? 'all';
  }

  private setStoredAnnotationColorFilter(filePath: string, value: string) {
    if (!filePath) return;
    this._sourceAnnotationColorFilterByFile.set(filePath, value || 'all');
  }

  private getStoredAnnotationTagFilter(filePath: string): string {
    return this._sourceAnnotationTagFilterByFile.get(filePath) ?? 'all';
  }

  private setStoredAnnotationTagFilter(filePath: string, value: string) {
    if (!filePath) return;
    this._sourceAnnotationTagFilterByFile.set(filePath, value || 'all');
  }

  private getSidebarSectionStateKey(sectionKey: string, contextKey?: string): string {
    const scope = (contextKey || this.getCurrentFilePath() || 'global').trim() || 'global';
    return `${scope}::${sectionKey.trim()}`;
  }

  private createSidebarSection(
    container: HTMLElement,
    title: string,
    options?: {
      sectionKey?: string;
      contextKey?: string;
      meta?: string;
      defaultOpen?: boolean;
      detailsClass?: string;
      bodyClass?: string;
    }
  ): { details: HTMLDetailsElement; body: HTMLDivElement } {
    const details = container.createEl('details', {
      cls: ['zotsidian-sidebar-section', options?.detailsClass || ''].filter(Boolean).join(' '),
    });
    const stateKey = this.getSidebarSectionStateKey(options?.sectionKey || title.toLowerCase(), options?.contextKey);
    details.open = this._sidebarSectionOpenState.get(stateKey) ?? (options?.defaultOpen ?? true);
    details.addEventListener('toggle', () => {
      this._sidebarSectionOpenState.set(stateKey, details.open);
    });

    const summary = details.createEl('summary', { cls: 'zotsidian-source-section-summary zotsidian-sidebar-section-summary' });
    const summaryLabel = summary.createDiv({ cls: 'zotsidian-source-section-summary-label' });
    summaryLabel.createEl('span', { cls: 'zotsidian-source-subtitle', text: title });
    if (options?.meta) {
      summaryLabel.createEl('div', {
        cls: 'zotsidian-source-section-summary-meta',
        text: options.meta,
      });
    }
    if (title === 'References') {
      this.addReferenceSectionSortButton(summary);
    }

    const body = details.createDiv({
      cls: ['zotsidian-sidebar-section-body', options?.bodyClass || ''].filter(Boolean).join(' '),
    });
    return { details, body };
  }

  private getAnnotationColorLabel(raw?: string): string {
    const value = (raw || '').trim().toLowerCase();
    if (!value) return 'Unknown color';
    const labels: Record<string, string> = {
      '#ffd400': 'Yellow',
      '#ff6666': 'Red',
      '#5fb236': 'Green',
      '#2ea8e5': 'Blue',
      '#a28ae5': 'Purple',
      '#e56eee': 'Magenta',
      '#f19837': 'Orange',
      '#aaaaaa': 'Gray',
    };
    return labels[value] || value;
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

  private attachReferenceHover(targetEl: HTMLElement, citekey: string) {
    targetEl.addEventListener('mouseenter', () => {
      if (!this.plugin.settings.showCitationHoverCard) return;
      if (this._hoverCardEl?.isConnected && this._hoverTargetEl && this._hoverTargetEl !== targetEl) {
        this.scheduleSwitchReferenceHoverCard(targetEl, citekey);
        return;
      }
      this.showReferenceHoverCard(targetEl, citekey);
    });
    targetEl.addEventListener('mouseleave', (evt: MouseEvent) => {
      const related = evt.relatedTarget;
      if (
        related instanceof Node &&
        (targetEl.contains(related) || this._hoverCardEl?.contains(related))
      ) {
        return;
      }
      this.scheduleHideReferenceHoverCard();
    });
  }

  private isSupportedPreviewImagePath(path: string): boolean {
    return /\.(png|jpe?g|gif|webp|svg|bmp)$/i.test((path || '').split('?')[0]);
  }

  private stripMarkdownLinkTarget(raw: string): string {
    return (raw || '')
      .trim()
      .replace(/^<|>$/g, '')
      .replace(/^file:\/\//, '')
      .split(/\s+"[^"]*"$/)[0]
      .trim();
  }

  private resolveImageLinkToResource(link: string, sourcePath: string): string | null {
    const clean = this.stripMarkdownLinkTarget(link);
    if (!clean) return null;
    if (/^https?:\/\//i.test(clean)) return clean;
    const decoded = decodeURIComponent(clean);
    if (!this.isSupportedPreviewImagePath(decoded)) return null;
    const linkedFile = this.plugin.app.metadataCache.getFirstLinkpathDest(decoded, sourcePath)
      || this.plugin.app.vault.getAbstractFileByPath(decoded);
    if (linkedFile instanceof TFile) {
      return this.plugin.app.vault.getResourcePath(linkedFile);
    }
    return null;
  }

  private async resolveFirstImageResourceForDiscourseNode(item: DraggableDiscourseNodeItem): Promise<string | null> {
    if (!this.plugin.settings.showDiscourseNodeImagePreview || !item.filePath) return null;
    const file = this.plugin.app.vault.getAbstractFileByPath(item.filePath);
    if (!(file instanceof TFile) || file.extension !== 'md') return null;
    const markdown = await this.plugin.app.vault.cachedRead(file);
    const embedMatch = markdown.match(/!\[\[([^\]\|#]+)(?:[|#][^\]]*)?\]\]/);
    if (embedMatch?.[1]) {
      const resolved = this.resolveImageLinkToResource(embedMatch[1], file.path);
      if (resolved) return resolved;
    }
    const markdownImageMatch = markdown.match(/!\[[^\]]*]\(([^)]+)\)/);
    if (markdownImageMatch?.[1]) {
      const resolved = this.resolveImageLinkToResource(markdownImageMatch[1], file.path);
      if (resolved) return resolved;
    }
    return null;
  }

  private createDiscourseNodeHoverCardElement(item: DraggableDiscourseNodeItem): HTMLElement {
    const card = document.createElement('div');
    card.className = 'zotsidian-hover-card zotsidian-sidebar-hover-card zotsidian-discourse-node-hover-card';
    const mediaSlot = card.createDiv({ cls: 'zotsidian-discourse-node-hover-media is-loading' });
    void this.resolveFirstImageResourceForDiscourseNode(item)
      .then((src) => {
        if (!card.isConnected) return;
        mediaSlot.empty();
        mediaSlot.removeClass('is-loading');
        if (!src) {
          mediaSlot.remove();
          return;
        }
        mediaSlot.createEl('img', {
          attr: {
            src,
            alt: item.title,
            loading: 'lazy',
          },
        });
      })
      .catch(() => {
        if (mediaSlot.isConnected) mediaSlot.remove();
      });
    const header = card.createDiv({ cls: 'zotsidian-discourse-node-hover-header' });
    const badge = header.createSpan({ cls: 'zotsidian-discourse-graph-type', text: item.nodeTypeName || 'Node' });
    if (item.nodeTypeColor) {
      badge.style.setProperty('--dg-node-type-color', item.nodeTypeColor);
    }
    card.createDiv({ cls: 'zotsidian-discourse-node-hover-title', text: item.title || 'Untitled discourse node' });
    if (item.filePath) {
      card.createDiv({ cls: 'zotsidian-discourse-node-hover-path', text: item.filePath });
    }
    const relatedSection = card.createDiv({ cls: 'zotsidian-discourse-node-hover-related' });
    const relatedTitle = relatedSection.createDiv({ cls: 'zotsidian-discourse-node-hover-related-title', text: 'Related nodes' });
    const relatedList = relatedSection.createDiv({ cls: 'zotsidian-discourse-node-hover-related-list' });
    relatedList.createDiv({ cls: 'zotsidian-discourse-node-hover-related-empty', text: 'Loading...' });
    void this.plugin.getRelatedDiscourseNodesForItem(item, 5)
      .then((relatedItems) => {
        if (!card.isConnected) return;
        relatedList.empty();
        if (relatedItems.length === 0) {
          relatedList.createDiv({ cls: 'zotsidian-discourse-node-hover-related-empty', text: 'No linked nodes found.' });
          return;
        }
        for (const related of relatedItems) {
          this.renderDiscourseNodeHoverRelatedRow(relatedList, related);
        }
      })
      .catch(() => {
        if (!card.isConnected) return;
        relatedList.empty();
        relatedList.createDiv({ cls: 'zotsidian-discourse-node-hover-related-empty', text: 'Could not load related nodes.' });
      });
    if (!relatedTitle.textContent) relatedTitle.remove();
    return card;
  }

  private renderDiscourseNodeHoverRelatedRow(container: HTMLElement, item: RelatedDiscourseNodeSidebarItem) {
    const row = container.createDiv({ cls: 'zotsidian-discourse-node-hover-related-row' });
    row.setAttribute('aria-label', item.title);
    this.attachDiscourseNodeDrag(row, item);
    const badge = row.createSpan({ cls: 'zotsidian-discourse-graph-type', text: item.nodeTypeName || 'Node' });
    if (item.nodeTypeColor) {
      badge.style.setProperty('--dg-node-type-color', item.nodeTypeColor);
    }
    const title = row.createEl('a', { cls: 'zotsidian-discourse-node-hover-related-node-title', text: item.title || 'Untitled node' });
    title.href = '#';
    title.setAttribute('draggable', 'false');
    title.addEventListener('click', async (evt) => {
      evt.preventDefault();
      evt.stopPropagation();
      if (!item.filePath) return;
      const file = this.plugin.app.vault.getAbstractFileByPath(item.filePath);
      if (file instanceof TFile) {
        await this.plugin.app.workspace.getLeaf(false).openFile(file);
      }
    });
    const direction = row.createSpan({
      cls: 'zotsidian-discourse-node-hover-related-direction',
      text: item.relationDirection === 'incoming' ? 'in' : item.relationDirection === 'outgoing' ? 'out' : 'both',
    });
    direction.setAttribute('title', item.relationDirection);
    const pinButton = row.createEl('button', {
      cls: `zotsidian-discourse-node-hover-related-pin${this.plugin.isDiscourseNodePinned(item.id) ? ' is-pinned' : ''}`,
      attr: {
        type: 'button',
        title: this.plugin.isDiscourseNodePinned(item.id) ? 'Unpin node' : 'Pin node',
        'aria-label': this.plugin.isDiscourseNodePinned(item.id) ? 'Unpin node' : 'Pin node',
      },
    });
    this.stabilizeSidebarControl(pinButton);
    setIcon(pinButton, this.plugin.isDiscourseNodePinned(item.id) ? 'pin-off' : 'pin');
    pinButton.addEventListener('click', async (evt) => {
      evt.preventDefault();
      evt.stopPropagation();
      const pinned = await this.plugin.togglePinnedDiscourseNode(item);
      pinButton.classList.toggle('is-pinned', pinned);
      setIcon(pinButton, pinned ? 'pin-off' : 'pin');
      pinButton.setAttribute('title', pinned ? 'Unpin node' : 'Pin node');
      await this.renderReferences();
    });
  }

  private showDiscourseNodeHoverCard(target: HTMLElement, item: DraggableDiscourseNodeItem) {
    this.clearHoverTimers();
    if (this._hoverTargetEl === target && this._hoverCardEl?.isConnected) {
      this.positionReferenceHoverCard(this._hoverCardEl, target);
      return;
    }
    this.hideReferenceHoverCard();
    const card = this.createDiscourseNodeHoverCardElement(item);
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

  private attachDiscourseNodeHover(targetEl: HTMLElement, item: DraggableDiscourseNodeItem) {
    targetEl.addEventListener('mouseenter', () => {
      if (!this.plugin.settings.enableDiscourseGraphsCompatibility) return;
      if (this._hoverCardEl?.isConnected && this._hoverTargetEl && this._hoverTargetEl !== targetEl) {
        if (this._hoverSwitchTimer != null) window.clearTimeout(this._hoverSwitchTimer);
        this._hoverSwitchTimer = window.setTimeout(() => {
          this._hoverSwitchTimer = null;
          this.showDiscourseNodeHoverCard(targetEl, item);
        }, 120);
        return;
      }
      this.showDiscourseNodeHoverCard(targetEl, item);
    });
    targetEl.addEventListener('mouseleave', (evt: MouseEvent) => {
      const related = evt.relatedTarget;
      if (
        related instanceof Node &&
        (targetEl.contains(related) || this._hoverCardEl?.contains(related))
      ) {
        return;
      }
      this.scheduleHideReferenceHoverCard();
    });
  }

  private stabilizeSidebarControl(target: HTMLElement) {
    target.addEventListener('mousedown', (evt) => {
      evt.stopPropagation();
      if (target instanceof HTMLSelectElement || target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
        return;
      }
      evt.preventDefault();
    });
  }

  private openReferenceSortMenu(evt: MouseEvent) {
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
  }

  private addSortMenuButton(header: HTMLElement) {
    const sortButton = header.createEl("button", {
      cls: "sort-button",
      title: this.getReferenceSortLabel(),
    });
    this.stabilizeSidebarControl(sortButton);
    setIcon(sortButton, "arrow-up-down");
    sortButton.onclick = (evt) => {
      this.openReferenceSortMenu(evt);
    };
  }

  private addReferenceSectionSortButton(summary: HTMLElement) {
    const tools = summary.createDiv({ cls: 'zotsidian-source-section-summary-tools zotsidian-reference-section-tools' });
    const sortButton = tools.createEl('button', {
      cls: 'sort-button zotsidian-reference-section-sort-button',
      title: this.getReferenceSortLabel(),
      attr: { type: 'button', 'aria-label': this.getReferenceSortLabel() },
    });
    this.stabilizeSidebarControl(sortButton);
    setIcon(sortButton, 'arrow-up-down');
    sortButton.onclick = (evt) => {
      this.openReferenceSortMenu(evt);
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
      this._statusEl.setAttribute('aria-label', 'Zotero connection status');
    } else {
      this._statusEl.setAttribute('aria-label', display.title);
      this._statusEl.setAttribute('title', `${display.title}\nClick to refresh Zotero connection and index.`);
      this._statusEl.addClass(`is-${display.tone}`);
    }

    if (this._refreshButtonEl) {
      const status = this.plugin.getCitationIndexStatus(this._headerScope || undefined);
      this._refreshButtonEl.toggleClass('is-loading', status.loading);
      this._refreshButtonEl.setAttribute('aria-busy', status.loading ? 'true' : 'false');
      this._refreshButtonEl.setAttribute('title', status.loading ? 'Refreshing Zotero index' : 'Refresh');
    }
  }

  private async refreshCurrentScopeFromUi(evt?: Event) {
    evt?.preventDefault();
    evt?.stopPropagation();
    await this.plugin.refreshActiveScopeAndView(true);
  }

  private buildHeader(container: HTMLElement, title: string, scope?: string, detectedMentions: number = 0, searchScope?: string) {
    const header = container.createDiv({ cls: 'references-header' });
    if (title === 'SOURCE') {
      header.addClass('is-source-header');
    }
    const titleWrap = header.createDiv({ cls: 'references-header-main' });
    titleWrap.createEl('span', { text: title, cls: 'references-header-text' });

    const actionsWrap = header.createDiv({ cls: 'references-header-actions' });
    const statusWrap = actionsWrap.createDiv({ cls: 'references-header-status-group' });
    this._statusEl = statusWrap.createEl('button', {
      cls: 'zotsidian-status-pill is-hidden',
      attr: { type: 'button', 'aria-label': 'Refresh Zotero connection and index' },
    });
    this.stabilizeSidebarControl(this._statusEl);
    this._statusEl.addClass('is-clickable');
    this._statusEl.addEventListener('click', async (evt) => {
      await this.refreshCurrentScopeFromUi(evt);
    });

    const buttonGroup = actionsWrap.createDiv({ cls: 'references-header-button-group' });
    const searchButton = buttonGroup.createEl('button', { cls: 'search-button', title: 'Search Zotero library', attr: { type: 'button' } });
    this.stabilizeSidebarControl(searchButton);
    setIcon(searchButton, 'search');
    this._refreshButtonEl = null;

    searchButton.onclick = () => {
      this.plugin.openSearchPanel(searchScope || this.activeFileCollectionData?.path || this.plugin.resolveScopeFromFrontmatter(undefined));
    };

    this._headerScope = scope || this.plugin.getActiveScope();
    this._headerDetectedMentions = detectedMentions;
    this.refreshHeaderStatus();
    return header;
  }

  private maybeRenderDiscourseCompatibilityHint(container: HTMLElement, mode: 'references' | 'source' | 'empty' | 'error' | 'loading') {
    void container;
    void mode;
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
    await this.plugin.primeVisibleCitationsFromActiveContext(activeFile);
    const discourseCanvasCitations = activeFile.extension === 'md'
      ? await this.plugin.getDiscourseCanvasDetectedCitations(activeFile)
      : null;
    const nativeCanvasCitations = activeFile.extension === 'canvas' && !this.plugin.isActiveDiscourseCanvasLeaf()
      ? await this.plugin.getNativeCanvasDetectedCitations(activeFile)
      : null;
    const baseFileCitations = activeFile.extension === 'base'
      ? await this.plugin.getBaseDetectedCitations(activeFile)
      : null;
    const baseCitations = discourseCanvasCitations ?? nativeCanvasCitations ?? baseFileCitations ?? this.plugin.getVisibleCitationsFromActiveContext(activeFile);
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
    const activeFile = this.getCurrentFile();
    if (!activeFile || activeFile.extension !== 'md') return null;
    if (!activeFile.basename.startsWith('@')) return null;
    const key = activeFile.basename.replace(/^@+/, '').trim();
    return key.length > 0 ? key : null;
  }

  private setSourceViewContent(content: HTMLElement, scope?: string, detectedMentions: number = 0) {
    this.hideReferenceHoverCard();
    this.contentEl.empty();
    const containerDiv = this.contentEl.createDiv({ cls: "zotsidian-container-div" });
    this.buildHeader(containerDiv, 'SOURCE', scope, detectedMentions, scope);
    containerDiv.appendChild(content);
    this._lastRenderedFilePath = this.getCurrentFilePath() || null;
    this._lastRenderedMode = 'source';
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
    const activeFile = this.getCurrentFile();
    if (!activeFile) {
      this.setEmptyView();
      return;
    }

    const cache = this.plugin.app.metadataCache.getFileCache(activeFile);
    const frontMatter = cache?.frontmatter as Record<string, unknown> | undefined;
    const scope = this.getScopeForSource(frontMatter);
    let itemData = this.mergeSourceData(citekey, undefined, frontMatter);
    const isStillActiveSource = () => this.getCurrentFilePath() === activeFile.path && this.getActiveSourceCitekey() === citekey;

    const containerDiv = document.createElement('div');
    containerDiv.classList.add('zotsidian-source-div');

    const title = typeof itemData['title'] === 'string' && itemData['title'] ? itemData['title'] : `@${citekey}`;
    const journal = typeof itemData['journal'] === 'string' ? itemData['journal'] : (typeof itemData['container-title'] === 'string' ? itemData['container-title'] : '');
    const year = typeof itemData['year'] === 'string' ? itemData['year'] : '';
    const doi = typeof itemData['DOI'] === 'string' ? itemData['DOI'] : '';
    const relatedPromise = this.plugin.settings.showSourceRelatedPapers
      ? this.plugin.getSourceRelatedData(scope, citekey, itemData).catch(() => null)
      : Promise.resolve(null);

    const sourceCitekey = containerDiv.createEl('div', { cls: 'zotsidian-source-citekey', text: `@${citekey}` });
    this.attachCitationDrag(sourceCitekey, citekey);
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
      this.addSourceAction(actions, selectUri, 'Zotero', 'library-big', false);
    }
    const webUrl = typeof itemData['URL'] === 'string' && itemData['URL']
      ? itemData['URL']
      : (typeof itemData['id'] === 'string' && String(itemData['id']).startsWith('http') ? String(itemData['id']) : '');
    if (webUrl) {
      this.addSourceAction(actions, webUrl, 'URL', 'link');
    }
    const semanticScholarUrl = this.semanticScholarUrl(doi, title);
    if (semanticScholarUrl) {
      this.addSourceAction(actions, semanticScholarUrl, 'Semantic', 'brain');
    }
    const googleScholarUrl = this.googleScholarUrlFromItemData(itemData);
    if (googleScholarUrl) {
      this.addSourceAction(actions, googleScholarUrl, 'Scholar', 'graduation-cap');
    }
    const connectedPapersUrl = this.connectedPapersUrl(doi, title);
    if (connectedPapersUrl) {
      this.addSourceAction(actions, connectedPapersUrl, 'Connected', 'git-branch');
    }

    this.setSourceViewContent(containerDiv, scope, (refs?.detectedCitations || []).filter((key) => key !== citekey).length);

    const citationMap = await this.plugin.getCitationMapFor(scope, [citekey]).catch(() => new Map<string, Record<string, unknown>>());
    if (!isStillActiveSource()) return;
    itemData = this.mergeSourceData(citekey, citationMap.get(citekey), frontMatter);

    if (this.plugin.settings.enableSidebarAttachments) {
      const attachmentHint = {
        itemKey: this.parseItemKey(itemData),
        zoteroItemID: (typeof itemData['zoteroItemID'] === 'string' ? itemData['zoteroItemID'] : undefined) as string | undefined,
        zotero: (typeof itemData['zotero'] === 'string' ? itemData['zotero'] : undefined) as string | undefined,
        citekey: (typeof itemData['id'] === 'string' ? itemData['id'] : citekey) as string | undefined,
        doi: (typeof itemData['DOI'] === 'string' ? itemData['DOI'] : undefined) as string | undefined,
        title: (typeof itemData['title'] === 'string' ? itemData['title'] : undefined) as string | undefined,
        zoteroDataDir: this.plugin.settings.zoteroDataDir || undefined,
      };
      const attachmentScope = scope.split('/')[0] || scope;
      const cacheKey = this.getSourceAttachmentCacheKey(attachmentScope, citekey);
      let attachmentRows: SidebarAttachmentRow[] = [];
      const cached = this._sourceAttachmentCache.get(cacheKey);
      if (cached && (Date.now() - cached.fetchedAt) < 120000) {
        attachmentRows = cached.rows;
      } else {
        try {
          const rawAttachments = await attachments(citekey, attachmentScope, attachmentHint);
          attachmentRows = Array.isArray(rawAttachments) ? rawAttachments as SidebarAttachmentRow[] : [];
          this._sourceAttachmentCache.set(cacheKey, {
            rows: attachmentRows,
            fetchedAt: Date.now(),
          });
        } catch (_err) {
          attachmentRows = [];
        }
      }
      if (!isStillActiveSource()) return;
      this.renderSourceAttachmentSections(containerDiv, attachmentRows, cacheKey, activeFile.path, false, citekey);
    }

    const related = await relatedPromise;
    if (!isStillActiveSource()) return;
    if (related) {
      this.renderSourceRelatedSection(containerDiv, related, scope, activeFile.path, false);
    }

    await this.renderDiscourseGraphSection(containerDiv, activeFile.path, { defaultOpen: true });
    if (!isStillActiveSource()) return;
    await this.renderInlineReferencesSection(containerDiv, refs, citekey, {
      referenceFilePath: activeFile.path,
      defaultOpen: true,
      emptyMessage: 'No inline citations in this source page.',
    });

    this.refreshHeaderStatus(scope, (refs?.detectedCitations || []).filter((key) => key !== citekey).length);
    this.scrollFocusedReferenceIntoView();
  }

  private wireSourcePageLink(linkEl: HTMLAnchorElement, citekey: string, title: string, itemData: Record<string, unknown>) {
    const existingFile = this.plugin.findSourceNoteFile(citekey);
    linkEl.setAttribute('href', existingFile?.path || '#');
    linkEl.setAttribute('data-citekey', citekey);
    this.attachCitationDrag(linkEl, citekey);
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

  private compactSourceLabel(label: string, maxLength: number = 58): string {
    const clean = (label || '').replace(/\s+/g, ' ').trim();
    if (clean.length <= maxLength) return clean;
    return `${clean.slice(0, Math.max(16, maxLength - 1)).trimEnd()}...`;
  }

  private escapeHtml(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  private buildDiscourseNodeDragMarkdown(item: DraggableDiscourseNodeItem): string {
    const title = (item.title || 'Untitled discourse node').replace(/\s+/g, ' ').trim();
    return `[[${title.replace(/\|/g, '/')}]]`;
  }

  private setMarkdownDragData(evt: DragEvent, markdown: string) {
    const transfer = evt.dataTransfer;
    if (!transfer) return;
    transfer.clearData();
    transfer.effectAllowed = 'copy';
    transfer.setData('text/plain', markdown);
    transfer.setData('text/markdown', markdown);
  }

  private attachCitationDrag(target: HTMLElement, citekey: string) {
    const normalized = this.plugin.normalizeCitekeyForInsert(citekey);
    if (!normalized) return;
    target.setAttribute('draggable', 'true');
    let dropHandler: ((evt: DragEvent) => void) | null = null;
    let cleanupDragListeners: (() => void) | null = null;
    target.addEventListener('dragstart', (evt: DragEvent) => {
      this.setMarkdownDragData(evt, `[@${normalized}]`);
      evt.stopPropagation();
      dropHandler = (dropEvt: DragEvent) => {
        const point = { x: dropEvt.clientX, y: dropEvt.clientY };
        if (!this.plugin.isDiscourseCanvasPoint(point.x, point.y)) return;
        dropEvt.preventDefault();
        dropEvt.stopPropagation();
        dropEvt.stopImmediatePropagation();
        void this.plugin.insertCitationAsDiscourseSourceNodeAtPoint(normalized, point.x, point.y);
      };
      cleanupDragListeners = () => {
        if (dropHandler) {
          document.removeEventListener('drop', dropHandler, true);
          dropHandler = null;
        }
        cleanupDragListeners = null;
      };
      document.addEventListener('drop', dropHandler, true);
    }, { capture: true });
    target.addEventListener('dragend', () => {
      cleanupDragListeners?.();
    });
  }

  private attachDiscourseNodeDrag(row: HTMLElement, item: DraggableDiscourseNodeItem) {
    row.setAttribute('draggable', 'true');
    row.setAttribute('aria-label', `Drag discourse node: ${item.title}`);
    row.addClass('is-draggable');
    let lastPoint: { x: number; y: number } | null = null;
    let handledCanvasDrop = false;
    let dropHandler: ((evt: DragEvent) => void) | null = null;
    let cleanupDragListeners: (() => void) | null = null;
    row.addEventListener('drag', (evt: DragEvent) => {
      if (evt.clientX || evt.clientY) {
        lastPoint = { x: evt.clientX, y: evt.clientY };
      }
    });
    row.addEventListener('dragstart', (evt: DragEvent) => {
      this.setMarkdownDragData(evt, this.buildDiscourseNodeDragMarkdown(item));
      evt.stopPropagation();
      row.addClass('is-dragging');
      handledCanvasDrop = false;
      dropHandler = (dropEvt: DragEvent) => {
        const point = { x: dropEvt.clientX, y: dropEvt.clientY };
        if (!this.plugin.isDiscourseCanvasPoint(point.x, point.y)) return;
        handledCanvasDrop = true;
        dropEvt.preventDefault();
        dropEvt.stopPropagation();
        dropEvt.stopImmediatePropagation();
        void this.plugin.insertDiscourseNodeMarkdownAtPoint(item, point.x, point.y);
      };
      cleanupDragListeners = () => {
        if (dropHandler) {
          document.removeEventListener('drop', dropHandler, true);
          dropHandler = null;
        }
        cleanupDragListeners = null;
      };
      document.addEventListener('drop', dropHandler, true);
    }, { capture: true });
    row.addEventListener('dragend', (evt: DragEvent) => {
      row.removeClass('is-dragging');
      cleanupDragListeners?.();
      if (handledCanvasDrop) return;
      const point = (evt.clientX || evt.clientY)
        ? { x: evt.clientX, y: evt.clientY }
        : lastPoint;
      if (point) {
        void this.plugin.insertDiscourseNodeMarkdownAtPoint(item, point.x, point.y);
      }
    });
  }

  private addSourceAction(container: HTMLElement, href: string, label: string, icon: string, external: boolean = true) {
    if (!href) return;
    const link = container.createEl('a', { cls: 'zotsidian-source-action', href });
    link.setAttribute('title', label);
    link.setAttribute('aria-label', label);
    if (external) {
      link.setAttribute('target', '_blank');
      link.setAttribute('rel', 'noopener noreferrer');
    }
    const iconEl = link.createSpan({ cls: 'zotsidian-source-action-icon' });
    setIcon(iconEl, icon);
  }

  private getPreferredMarkdownInsertView(): MarkdownView | null {
    const activeLeaf = this.plugin.app.workspace.activeLeaf;
    if (activeLeaf?.view instanceof MarkdownView) {
      return activeLeaf.view;
    }
    const leaves = this.plugin.app.workspace.getLeavesOfType('markdown');
    const recent = this.plugin.app.workspace.getMostRecentLeaf();
    if (recent?.view instanceof MarkdownView) {
      return recent.view;
    }
    const leaf = leaves.find((item) => item.view instanceof MarkdownView);
    return leaf?.view instanceof MarkdownView ? leaf.view : null;
  }

  private async insertTextIntoCurrentMarkdown(text: string): Promise<boolean> {
    const view = this.getPreferredMarkdownInsertView();
    if (!(view instanceof MarkdownView)) return false;
    const editor = view.editor;
    const cursor = editor.getCursor('head');
    const normalized = text.endsWith('\n') ? text : `${text}\n`;
    editor.replaceRange(normalized, cursor);
    editor.setCursor({ line: cursor.line + normalized.split('\n').length - 1, ch: 0 });
    return true;
  }

  private async loadAnnotationInsertTemplate(kind: 'text' | 'image'): Promise<string> {
    try {
      const preset = normalizeAnnotationTemplatePreset(this.plugin.settings.annotationTemplatePreset);
      if (preset !== 'custom') {
        return getBuiltInAnnotationTemplate(preset, kind);
      }
      const configuredPath = getConfiguredTemplatePath(
        this.plugin.settings,
        kind === 'image' ? 'annotation-image' : 'annotation-text'
      );
      if (!configuredPath) return '';
      return await this.plugin.app.vault.adapter.read(configuredPath);
    } catch (_err) {
      return '';
    }
  }

  private buildAnnotationInsertTemplateContext(annotation: SidebarAnnotation, openHref?: string): TemplateRenderContext {
    const localImagePath = this.resolveAnnotationLocalImagePath(annotation);
    return buildAnnotationInsertTemplateContext({
      ...annotation,
      openHref,
      localImagePath,
      localImageEmbed: localImagePath ? this.buildLocalImageEmbed(localImagePath) : '',
      formattedDate: this.formatAnnotationDate(annotation.dateModified || annotation.dateAdded),
    });
  }

  private async buildAnnotationInsertPayload(annotation: SidebarAnnotation, openHref?: string): Promise<string> {
    const type = (annotation.annotationType || '').trim().toLowerCase();
    const kind: 'text' | 'image' = type === 'image' ? 'image' : 'text';
    const context = this.buildAnnotationInsertTemplateContext(annotation, openHref);
    const localImagePath = typeof context.localImagePath === 'string' ? context.localImagePath : '';
    const localImageEmbed = typeof context.localImageEmbed === 'string' ? context.localImageEmbed : '';
    const formattedDate = typeof context.date === 'string' ? context.date : '';
    const defaultPayload = typeof context.defaultPayload === 'string' ? context.defaultPayload : '';
    const template = (await this.loadAnnotationInsertTemplate(kind)).trim();
    if (template) {
      return renderAnnotationInsertPayload(template, {
        ...annotation,
        openHref,
        localImagePath,
        localImageEmbed,
        formattedDate,
      }).trim();
    }
    return defaultPayload.trim();
  }

  private async insertAnnotation(annotation: SidebarAnnotation, openHref?: string): Promise<boolean> {
    const payload = await this.buildAnnotationInsertPayload(annotation, openHref);
    if (!payload) return false;
    return this.insertTextIntoCurrentMarkdown(`${payload}\n`);
  }

  private async insertAnnotations(annotations: SidebarAnnotation[], openHrefByKey: Map<string, string>): Promise<boolean> {
    const payloads = (await Promise.all(
      annotations.map((annotation) => this.buildAnnotationInsertPayload(annotation, openHrefByKey.get(annotation.key)))
    )).filter((payload) => payload.length > 0);
    if (payloads.length === 0) return false;
    return this.insertTextIntoCurrentMarkdown(`${payloads.join('\n\n')}\n`);
  }

  private resolveAnnotationOpenHref(annotation: SidebarAnnotation, fallbackOpenHref?: string): string {
    return (annotation.openHref || fallbackOpenHref || '').trim();
  }

  private renderAnnotationCard(container: HTMLElement, annotation: SidebarAnnotation, openHref?: string, sourceCitekey?: string) {
    const resolvedOpenHref = this.resolveAnnotationOpenHref(annotation, openHref);
    const normalizedAnnotationKey = (annotation.key || '').trim().toUpperCase();
    const card = container.createDiv({
      cls: 'zotsidian-source-annotation-card',
      attr: {
        tabindex: '0',
        role: 'button',
      },
    });
    card.dataset.annotationType = this.getAnnotationTypeLabel(annotation.annotationType).toLowerCase();
    card.dataset.annotationColor = (annotation.annotationColor || '').trim().toLowerCase();
    const annotationTags = this.getAnnotationTagLabels(annotation);
    card.dataset.annotationTags = annotationTags.map((tag) => tag.toLowerCase()).join('\u001f');
    card.dataset.annotationKey = normalizedAnnotationKey;
    if (normalizedAnnotationKey && this.plugin.getActiveSourceAnnotationKey() === normalizedAnnotationKey) {
      card.addClass('is-active-source-annotation');
    }
    if (annotation.annotationColor) {
      card.style.setProperty('--annotation-color', annotation.annotationColor);
    }
    if ((annotation.annotationType || '').trim().toLowerCase() === 'image') {
      card.addClass('is-image-annotation');
    }
    const openCopyMenu = (evt: MouseEvent) => {
      const selection = window.getSelection()?.toString().trim() || '';
      if (selection.length > 0) return;
      evt.preventDefault();
      evt.stopPropagation();
      this.showAnnotationCopyMenu(annotation, evt, resolvedOpenHref);
    };
    const openZoteroTarget = (evt?: Event) => {
      evt?.preventDefault();
      evt?.stopPropagation();
      if (resolvedOpenHref) {
        this.openLinkTarget(resolvedOpenHref);
      }
    };
    const activate = async (evt?: Event) => {
      evt?.preventDefault();
      evt?.stopPropagation();
      const jumped = await this.plugin.jumpToSourceAnnotation(sourceCitekey || annotation.parentItem, annotation.key);
      if (!jumped) {
        openZoteroTarget();
      }
    };
    card.addEventListener('click', (evt) => void activate(evt));
    card.addEventListener('keydown', (evt: KeyboardEvent) => {
      if (evt.key === 'Enter' || evt.key === ' ') {
        void activate(evt);
      }
    });

    const cardHeader = card.createDiv({ cls: 'zotsidian-source-annotation-header' });
    const topRow = cardHeader.createDiv({ cls: 'zotsidian-source-annotation-topline' });
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
      colorDot.setAttribute('title', annotationTags.length > 0
        ? `${annotation.annotationColor} · ${annotationTags.join(', ')}`
        : annotation.annotationColor);
    }
    for (const label of annotationTags.slice(0, 3)) {
      topRow.createSpan({
        cls: 'zotsidian-source-annotation-tag',
        text: label,
        attr: { title: label },
      });
    }

    const actions = cardHeader.createDiv({ cls: 'zotsidian-source-annotation-actions' });
    const annotationKind = (annotation.annotationType || '').trim().toLowerCase();
    const isImageAnnotation = annotationKind === 'image';
    const canCopy = this.hasAnnotationCopyPayload(annotation);
    const copyButton = actions.createEl('button', {
      cls: 'zotsidian-source-annotation-action',
      attr: { type: 'button', 'aria-label': isImageAnnotation ? 'Copy annotation image' : 'Copy annotation text' },
      title: isImageAnnotation ? 'Copy annotation image' : 'Copy annotation text',
    });
    this.stabilizeSidebarControl(copyButton);
    const copyIcon = copyButton.createSpan({ cls: 'zotsidian-source-annotation-action-icon' });
    setIcon(copyIcon, 'copy');
    copyButton.toggleAttribute('disabled', !canCopy);
    copyButton.addEventListener('click', async (evt) => {
      evt.preventDefault();
      evt.stopPropagation();
      if (isImageAnnotation) {
        await this.copyAnnotationImageDefault(annotation, resolvedOpenHref);
        return;
      }
      await this.copyAnnotation(annotation, resolvedOpenHref, this.plugin.settings.annotationTextCopyDefault);
    });
    copyButton.addEventListener('contextmenu', (evt) => {
      evt.preventDefault();
      evt.stopPropagation();
      this.showAnnotationCopyMenu(annotation, evt, resolvedOpenHref);
    });
    const insertButton = actions.createEl('button', {
      cls: 'zotsidian-source-annotation-action',
      attr: { type: 'button', 'aria-label': 'Insert annotation into current note' },
      title: 'Insert annotation into current note',
    });
    this.stabilizeSidebarControl(insertButton);
    const insertIcon = insertButton.createSpan({ cls: 'zotsidian-source-annotation-action-icon' });
    setIcon(insertIcon, 'corner-down-left');
    insertButton.addEventListener('click', async (evt) => {
      evt.preventDefault();
      evt.stopPropagation();
      const inserted = await this.insertAnnotation(annotation, resolvedOpenHref);
      new Notice(inserted ? 'Annotation inserted.' : 'No active markdown note available for insertion.');
    });
    const openButton = actions.createEl('button', {
      cls: 'zotsidian-source-annotation-action',
      attr: { type: 'button', 'aria-label': 'Open parent PDF or Zotero item' },
      title: 'Open parent PDF or Zotero item',
    });
    this.stabilizeSidebarControl(openButton);
    const openIcon = openButton.createSpan({ cls: 'zotsidian-source-annotation-action-icon' });
    setIcon(openIcon, 'arrow-up-right');
    openButton.addEventListener('click', (evt) => {
      evt.preventDefault();
      evt.stopPropagation();
      openZoteroTarget();
    });

    const potentialImageSrc = this.resolveAnnotationImageSrc(annotation);
    if (potentialImageSrc) {
      const imageWrap = card.createDiv({ cls: 'zotsidian-source-annotation-image' });
      imageWrap.addEventListener('contextmenu', (evt) => {
        evt.preventDefault();
        evt.stopPropagation();
        this.showAnnotationCopyMenu(annotation, evt, resolvedOpenHref);
      });
      this.mountAnnotationImagePreview(imageWrap, annotation, () => void activate());
    }

    if (annotation.annotationText && annotation.annotationText.trim().length > 0) {
      const textEl = card.createDiv({
        cls: 'zotsidian-source-annotation-text',
        text: annotation.annotationText.trim(),
      });
      textEl.addEventListener('contextmenu', openCopyMenu);
    }

    if (annotation.annotationComment && annotation.annotationComment.trim().length > 0) {
      const commentEl = card.createDiv({
        cls: 'zotsidian-source-annotation-comment',
        text: annotation.annotationComment.trim(),
      });
      commentEl.addEventListener('contextmenu', openCopyMenu);
    }

    if (!annotation.annotationText?.trim() && !annotation.annotationComment?.trim() && !potentialImageSrc) {
      card.createDiv({
        cls: 'zotsidian-source-annotation-empty',
        text: (annotation.annotationType || '').trim().toLowerCase() === 'image'
          ? 'Image annotation preview unavailable. Use Open to inspect it in Zotero.'
          : 'No highlight text or comment available.',
      });
    }
  }

  private sortAnnotationsByPdfOrder(annotations: SidebarAnnotation[]): SidebarAnnotation[] {
    return [...annotations].sort((a, b) => this.compareAnnotationsByPdfOrder(a, b));
  }

  private compareAnnotationsByPdfOrder(a: SidebarAnnotation, b: SidebarAnnotation): number {
    const pageA = this.parseAnnotationPage(a.annotationPageLabel);
    const pageB = this.parseAnnotationPage(b.annotationPageLabel);
    if (pageA !== pageB) return pageA - pageB;
    const sortA = (a.annotationSortIndex || '').trim();
    const sortB = (b.annotationSortIndex || '').trim();
    if (sortA && sortB && sortA !== sortB) return sortA.localeCompare(sortB, undefined, { numeric: true });
    if (sortA && !sortB) return -1;
    if (!sortA && sortB) return 1;
    const dateA = Date.parse(a.dateAdded || a.dateModified || '') || 0;
    const dateB = Date.parse(b.dateAdded || b.dateModified || '') || 0;
    return dateA - dateB;
  }

  private parseAnnotationPage(value: string | undefined): number {
    const matched = (value || '').match(/\d+/);
    return matched ? Number(matched[0]) : Number.MAX_SAFE_INTEGER;
  }

  private scrollActiveSourceAnnotationIntoView(annotationSection: HTMLElement) {
    const activeCard = annotationSection.querySelector<HTMLElement>('.zotsidian-source-annotation-card.is-active-source-annotation:not(.is-filtered-out)');
    if (!activeCard) return;
    window.requestAnimationFrame(() => {
      if (!activeCard.isConnected) return;
      activeCard.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
    });
  }

  private renderAttachmentLink(section: HTMLElement, row: SidebarAttachmentRow) {
    const attachmentLine = section.createDiv({ cls: 'zotsidian-source-attachment-line' });
    const iconWrap = attachmentLine.createSpan({ cls: 'zotsidian-source-attachment-icon' });
    setIcon(iconWrap, typeof row.open === 'string' && row.open.startsWith('zotero://open-pdf/') ? 'paperclip' : 'file');
    const label = typeof row.label === 'string' && row.label.trim().length > 0
      ? row.label.trim()
      : (typeof row.open === 'string' && row.open.startsWith('zotero://open-pdf/') ? 'Open PDF' : 'Open attachment');
    const link = attachmentLine.createEl('a', { href: row.open || '#', text: this.compactSourceLabel(label) });
    link.setAttribute('title', label);
    if (typeof row.open === 'string' && row.open.startsWith('http')) {
      link.setAttribute('target', '_blank');
      link.setAttribute('rel', 'noopener noreferrer');
    }
    const annotationCount = Array.isArray(row.annotations) ? row.annotations.length : 0;
    if (annotationCount > 0) {
      attachmentLine.createSpan({
        cls: 'zotsidian-source-attachment-count',
        text: `${annotationCount}`,
      });
    }
  }

  private renderSourceAttachmentSections(containerDiv: HTMLElement, attachmentRows: SidebarAttachmentRow[], cacheKey: string, filePath: string, collapsible: boolean = true, sourceCitekey?: string) {
    const attachmentCount = attachmentRows.length;
    let attachmentSection: HTMLElement;
    if (collapsible) {
      ({ body: attachmentSection } = this.createSidebarSection(containerDiv, 'Attachments', {
        sectionKey: 'source-attachments',
        contextKey: filePath,
        meta: `${attachmentCount} item${attachmentCount === 1 ? '' : 's'}`,
        defaultOpen: false,
        detailsClass: 'zotsidian-source-attachments',
      }));
    } else {
      attachmentSection = containerDiv.createDiv({ cls: 'zotsidian-source-attachments zotsidian-source-attachments-inline' });
      attachmentSection.createEl('div', { cls: 'zotsidian-source-subtitle', text: 'Attachments' });
    }

    if (attachmentRows.length === 0) {
      attachmentSection.createEl('div', { cls: 'zotsidian-source-empty', text: 'No attachment metadata available.' });
    } else {
      for (const row of attachmentRows) {
        if (!row || typeof row !== 'object' || typeof row.open !== 'string' || row.open.length === 0) continue;
        this.renderAttachmentLink(attachmentSection, row);
      }
    }

    const annotationCount = attachmentRows.reduce((sum, row) => sum + (Array.isArray(row.annotations) ? row.annotations.length : 0), 0);
    const annotationSection = containerDiv.createEl('details', {
      cls: 'zotsidian-source-annotations',
    });
    const activeSourceAnnotationKey = this.plugin.getActiveSourceAnnotationKey(filePath);
    annotationSection.open = this.getStoredAnnotationOpenState(filePath) || !!activeSourceAnnotationKey;
    annotationSection.addEventListener('toggle', () => {
      this.setStoredAnnotationOpenState(filePath, annotationSection.open);
    });
    const annotationSummary = annotationSection.createEl('summary', { cls: 'zotsidian-source-section-summary' });
    const summaryLabel = annotationSummary.createDiv({ cls: 'zotsidian-source-section-summary-label' });
    summaryLabel.createEl('span', { cls: 'zotsidian-source-subtitle', text: 'Annotations' });
    summaryLabel.createEl('div', {
      cls: 'zotsidian-source-section-summary-meta',
      text: `${annotationCount} item${annotationCount === 1 ? '' : 's'}`,
    });
    const summaryTools = annotationSummary.createDiv({ cls: 'zotsidian-source-section-summary-tools' });
    const refreshButton = summaryTools.createEl('button', {
      cls: 'zotsidian-source-section-refresh',
      title: 'Refresh source sidebar and annotations',
      attr: { type: 'button' },
    });
    this.stabilizeSidebarControl(refreshButton);
    setIcon(refreshButton, 'refresh-cw');
    refreshButton.addEventListener('click', async (evt) => {
      evt.preventDefault();
      evt.stopPropagation();
      this._sourceAttachmentCache.delete(cacheKey);
      this._annotationImageSrcCache.clear();
      await this.refreshCurrentScopeFromUi(evt);
    });

    if (attachmentRows.length === 0) {
      annotationSection.createEl('div', {
        cls: 'zotsidian-source-empty',
        text: 'Annotations are unavailable because no attachments were found for this source.',
      });
      return;
    }

    const groups = attachmentRows
      .map((row) => ({
        ...row,
        annotations: this.sortAnnotationsByPdfOrder(row.annotations || []),
      }))
      .filter((row) => Array.isArray(row.annotations) && row.annotations.length > 0);
    if (groups.length === 0) {
      annotationSection.createEl('div', {
        cls: 'zotsidian-source-empty',
        text: 'No annotations were returned for these attachments.',
      });
      return;
    }

    const allAnnotations = groups.flatMap((row) => row.annotations || []);
    const annotationOpenHrefByKey = new Map<string, string>();
    for (const row of groups) {
      for (const annotation of row.annotations || []) {
        if (annotation?.key) {
          annotationOpenHrefByKey.set(annotation.key, this.resolveAnnotationOpenHref(annotation, row.open));
        }
      }
    }
    this.prefetchVisibleAnnotationImages(allAnnotations);
    const typeValues = Array.from(new Set(allAnnotations
      .map((annotation) => this.getAnnotationTypeLabel(annotation.annotationType))
      .filter((value) => value.length > 0))).sort();
    const colorValues = Array.from(new Set(allAnnotations
      .map((annotation) => (annotation.annotationColor || '').trim())
      .filter((value) => value.length > 0)));
    const tagValues = Array.from(new Set(allAnnotations
      .flatMap((annotation) => this.getAnnotationTagLabels(annotation))
      .filter((value) => value.length > 0))).sort((a, b) => a.localeCompare(b));
    const colorTagLabels = new Map<string, string[]>();
    for (const annotation of allAnnotations) {
      const color = (annotation.annotationColor || '').trim();
      if (!color) continue;
      const current = colorTagLabels.get(color) || [];
      const seen = new Set(current.map((label) => label.toLowerCase()));
      for (const label of this.getAnnotationTagLabels(annotation)) {
        if (seen.has(label.toLowerCase())) continue;
        current.push(label);
        seen.add(label.toLowerCase());
      }
      colorTagLabels.set(color, current);
    }
    let activeType = this.getStoredAnnotationTypeFilter(filePath);
    let activeColor = this.getStoredAnnotationColorFilter(filePath);
    let activeTag = this.getStoredAnnotationTagFilter(filePath);

    const filterBar = annotationSection.createDiv({ cls: 'zotsidian-source-annotation-filters' });
    const typeFilters = filterBar.createDiv({ cls: 'zotsidian-source-annotation-type-filters' });
    if (!['all', ...typeValues.map((value) => value.toLowerCase())].includes(activeType)) {
      activeType = 'all';
      this.setStoredAnnotationTypeFilter(filePath, activeType);
    }
    const makeTypeButton = (value: string, label: string) => {
      const button = typeFilters.createEl('button', {
        cls: 'zotsidian-source-annotation-type-filter',
        text: label,
        attr: { type: 'button', title: label, 'aria-label': label },
      });
      this.stabilizeSidebarControl(button);
      button.dataset.value = value;
      button.addEventListener('click', () => {
        activeType = value;
        this.setStoredAnnotationTypeFilter(filePath, activeType);
        syncTypeButtons();
        applyFilters();
      });
      return button;
    };
    const typeButtons = [
      makeTypeButton('all', 'All'),
      ...typeValues.map((value) => makeTypeButton(value.toLowerCase(), value[0].toUpperCase() + value.slice(1))),
    ];
    const colorSwatches = filterBar.createDiv({ cls: 'zotsidian-source-annotation-color-swatches' });
    const makeColorButton = (value: string, label: string) => {
      const button = colorSwatches.createEl('button', {
        cls: 'zotsidian-source-annotation-color-filter',
        attr: { type: 'button', title: label, 'aria-label': label },
      });
      this.stabilizeSidebarControl(button);
      button.style.setProperty('--annotation-swatch-color', value);
      button.createSpan({ cls: 'zotsidian-source-annotation-color-filter-swatch' });
      button.addEventListener('click', () => {
        activeColor = activeColor === value ? 'all' : value;
        this.setStoredAnnotationColorFilter(filePath, activeColor);
        syncColorButtons();
        applyFilters();
      });
      return button;
    };
    const colorButtons = colorValues.map((value) => {
      const tags = colorTagLabels.get(value) || [];
      const label = tags.length > 0
        ? `${this.getAnnotationColorLabel(value)} · ${tags.join(', ')}`
        : this.getAnnotationColorLabel(value);
      return makeColorButton(value, label);
    });
    const tagFilters = filterBar.createDiv({ cls: 'zotsidian-source-annotation-tag-filters' });
    if (!['all', ...tagValues.map((value) => value.toLowerCase())].includes(activeTag)) {
      activeTag = 'all';
      this.setStoredAnnotationTagFilter(filePath, activeTag);
    }
    const tagButtons = tagValues.map((value) => {
      const normalized = value.toLowerCase();
      const button = tagFilters.createEl('button', {
        cls: 'zotsidian-source-annotation-tag-filter',
        text: value,
        attr: { type: 'button', title: `Tag: ${value}`, 'aria-label': `Filter annotation tag ${value}` },
      });
      this.stabilizeSidebarControl(button);
      button.dataset.value = normalized;
      button.addEventListener('click', () => {
        activeTag = activeTag === normalized ? 'all' : normalized;
        this.setStoredAnnotationTagFilter(filePath, activeTag);
        syncTagButtons();
        applyFilters();
      });
      return button;
    });
    const insertAllButton = filterBar.createEl('button', {
      cls: 'zotsidian-source-annotation-bulk-insert',
      attr: { type: 'button', 'aria-label': 'Insert filtered annotations into current note' },
      title: 'Insert filtered annotations into current note',
    });
    this.stabilizeSidebarControl(insertAllButton);
    const insertAllIcon = insertAllButton.createSpan({ cls: 'zotsidian-source-annotation-action-icon' });
    setIcon(insertAllIcon, 'corner-down-left');
    insertAllButton.addEventListener('click', async (evt) => {
      evt.preventDefault();
      evt.stopPropagation();
      const filteredAnnotations = allAnnotations.filter((annotation) => {
        const type = this.getAnnotationTypeLabel(annotation.annotationType).toLowerCase();
        const color = (annotation.annotationColor || '').trim().toLowerCase();
        const tags = this.getAnnotationTagLabels(annotation).map((tag) => tag.toLowerCase());
        const typeVisible = activeType === 'all' || type === activeType;
        const colorVisible = activeColor === 'all' || color === activeColor;
        const tagVisible = activeTag === 'all' || tags.includes(activeTag);
        return typeVisible && colorVisible && tagVisible;
      });
      const inserted = await this.insertAnnotations(filteredAnnotations, annotationOpenHrefByKey);
      new Notice(
        inserted
          ? `Inserted ${filteredAnnotations.length} annotation${filteredAnnotations.length === 1 ? '' : 's'}.`
          : 'No active markdown note available for insertion.',
      );
    });
    const syncColorButtons = () => {
      colorButtons.forEach((button) => {
        const buttonValue = (button.style.getPropertyValue('--annotation-swatch-color') || '').trim().toLowerCase();
        button.classList.toggle('is-active', buttonValue === activeColor);
      });
    };
    const syncTypeButtons = () => {
      typeButtons.forEach((button) => {
        button.classList.toggle('is-active', (button.dataset.value || 'all') === activeType);
      });
    };
    const syncTagButtons = () => {
      tagButtons.forEach((button) => {
        button.classList.toggle('is-active', (button.dataset.value || 'all') === activeTag);
      });
    };

    const applyFilters = () => {
      const cards = annotationSection.querySelectorAll<HTMLElement>('.zotsidian-source-annotation-card');
      const groupEls = annotationSection.querySelectorAll<HTMLElement>('.zotsidian-source-annotation-group');
      cards.forEach((card) => {
        const type = (card.dataset.annotationType || '').trim().toLowerCase();
        const color = (card.dataset.annotationColor || '').trim().toLowerCase();
        const tags = (card.dataset.annotationTags || '').split('\u001f').map((tag) => tag.trim()).filter(Boolean);
        const typeVisible = activeType === 'all' || type === activeType;
        const colorVisible = activeColor === 'all' || color === activeColor;
        const tagVisible = activeTag === 'all' || tags.includes(activeTag);
        card.classList.toggle('is-filtered-out', !(typeVisible && colorVisible && tagVisible));
      });
      groupEls.forEach((group) => {
        const hasVisible = !!group.querySelector('.zotsidian-source-annotation-card:not(.is-filtered-out)');
        group.classList.toggle('is-filtered-out', !hasVisible);
      });
    };

    for (const row of groups) {
      const group = annotationSection.createDiv({ cls: 'zotsidian-source-annotation-group' });
      const groupHeader = group.createDiv({ cls: 'zotsidian-source-annotation-group-header' });
      const groupLabel = typeof row.label === 'string' && row.label.trim().length > 0 ? row.label.trim() : 'Attachment';
      const groupLink = groupHeader.createEl('a', {
        href: row.open || '#',
        text: this.compactSourceLabel(groupLabel, 56),
      });
      groupLink.setAttribute('title', groupLabel);
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
        this.renderAnnotationCard(list, annotation, this.resolveAnnotationOpenHref(annotation, row.open), sourceCitekey);
      }
    }

    syncTypeButtons();
    syncColorButtons();
    syncTagButtons();
    applyFilters();
    this.scrollActiveSourceAnnotationIntoView(annotationSection);
  }

  private async resolvePreferredItemLink(citekey: string, itemData: Record<string, unknown>, scope: string): Promise<string> {
    const hint = {
      itemKey: this.parseItemKey(itemData),
      zoteroItemID: (typeof itemData['zoteroItemID'] === 'string' ? itemData['zoteroItemID'] : undefined) as string | undefined,
      zotero: (typeof itemData['zotero'] === 'string' ? itemData['zotero'] : undefined) as string | undefined,
      citekey: (typeof itemData['id'] === 'string' ? itemData['id'] : citekey) as string | undefined,
      doi: (typeof itemData['DOI'] === 'string' ? itemData['DOI'] : undefined) as string | undefined,
      title: (typeof itemData['title'] === 'string' ? itemData['title'] : undefined) as string | undefined,
      zoteroDataDir: this.plugin.settings.zoteroDataDir || undefined,
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
    void section;
    void note;
  }

  private renderSourceRelatedSection(containerDiv: HTMLElement, related: SourceRelatedData, scope: string, filePath?: string, collapsible: boolean = true) {
    let section: HTMLElement;
    if (collapsible) {
      ({ body: section } = this.createSidebarSection(containerDiv, 'Related', {
        sectionKey: 'source-related',
        contextKey: filePath || scope,
        meta: `${related.referenceCount + related.citationCount + related.relatedLibraryItems.length} signals`,
        defaultOpen: false,
        detailsClass: 'zotsidian-source-related',
      }));
      const divider = section.createDiv({ cls: 'zotsidian-source-related-divider' });
      void divider;
    } else {
      section = containerDiv.createDiv({ cls: 'zotsidian-source-related zotsidian-source-related-inline' });
      section.createEl('div', { cls: 'zotsidian-source-subtitle', text: 'Related' });
    }

    const bar = section.createDiv({ cls: 'zotsidian-source-related-bar' });
    const refButton = bar.createEl('button', {
      cls: 'zotsidian-source-related-button zotsidian-source-related-button-reference',
      text: '',
    });
    this.stabilizeSidebarControl(refButton);
    const refIcon = refButton.createSpan({ cls: 'zotsidian-source-related-button-icon' });
    setIcon(refIcon, 'quote-glyph');
    refButton.createSpan({ cls: 'zotsidian-source-related-button-label', text: `${related.referenceCount} references` });
    refButton.disabled = related.references.length === 0;
    refButton.onclick = () => {
      new SourceRelatedModal(this.app, this.plugin, scope, related.title, 'references', related.references).open();
    };

    const citationButton = bar.createEl('button', {
      cls: 'zotsidian-source-related-button zotsidian-source-related-button-citation',
      text: '',
    });
    this.stabilizeSidebarControl(citationButton);
    const citationIcon = citationButton.createSpan({ cls: 'zotsidian-source-related-button-icon' });
    setIcon(citationIcon, 'message-square-quote');
    citationButton.createSpan({ cls: 'zotsidian-source-related-button-label', text: `${related.citationCount} citations` });
    citationButton.disabled = related.citations.length === 0;
    citationButton.onclick = () => {
      new SourceRelatedModal(this.app, this.plugin, scope, related.title, 'citations', related.citations).open();
    };

    const relatedButton = bar.createEl('button', {
      cls: 'zotsidian-source-related-button zotsidian-source-related-button-library',
      text: '',
    });
    this.stabilizeSidebarControl(relatedButton);
    const libraryIcon = relatedButton.createSpan({ cls: 'zotsidian-source-related-button-icon' });
    setIcon(libraryIcon, 'library');
    relatedButton.createSpan({ cls: 'zotsidian-source-related-button-label', text: `${related.relatedLibraryItems.length} related library items` });
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

  private renderReferenceRow(
    containerDiv: HTMLElement,
    citekey: string,
    itemData: Record<string, unknown>,
    scope: string,
    focusState: 'none' | 'primary' | 'secondary' = 'none',
    occurrenceTargets?: ReferenceLocateTarget[] | null,
    referenceFilePath?: string
  ) {
    const { title, journal, issueDate } = this.getReferenceDisplayData(itemData);
    const referenceFile = referenceFilePath
      ? this.plugin.app.vault.getAbstractFileByPath(referenceFilePath)
      : null;
    const allowLocateButtons = !(referenceFile instanceof TFile && referenceFile.extension === 'base');
    const itemDiv = containerDiv.createDiv({ cls: 'reference-div' });
    if (focusState !== 'none') {
      itemDiv.addClass('is-focused');
      itemDiv.addClass(focusState === 'primary' ? 'is-focused-primary' : 'is-focused-secondary');
      if (focusState === 'primary') {
        itemDiv.setAttribute('aria-current', 'true');
      }
    }
    const citekeyDiv = itemDiv.createDiv({ cls: "reference-citekey", attr: { 'data-citekey': citekey } });
    const citekeyLink = citekeyDiv.createEl('a', { text: `@${citekey}` });
    this.attachReferenceHover(citekeyLink, citekey);
    this.wireSourcePageLink(citekeyLink, citekey, title, itemData);
    if (allowLocateButtons && (occurrenceTargets?.length || 0) > 0) {
      const locateGroup = citekeyDiv.createSpan({ cls: 'reference-locate-group' });
      locateGroup.createSpan({ cls: 'reference-locate-label', text: 'cited:' });
      occurrenceTargets?.forEach((target, index) => {
        const locateButton = locateGroup.createEl('button', {
          cls: 'reference-locate-button',
          text: String(index + 1),
          attr: { type: 'button' },
        });
        this.stabilizeSidebarControl(locateButton);
        locateButton.title = target.kind === 'markdown'
          ? `Jump to citation location ${index + 1}`
          : `Jump to canvas location ${index + 1}`;
        locateButton.addEventListener('click', async (evt) => {
          evt.preventDefault();
          evt.stopPropagation();
          const located = await this.plugin.locateReferenceOccurrence(
            referenceFilePath || this.getCurrentFilePath(),
            citekey,
            target.id
          );
          if (!located) {
            new Notice('No citation location was found in the active document.');
          }
        });
      });
    }
    const titleLink = itemDiv.createDiv({ cls: "reference-title" }).createEl('a', { text: title });
    this.wirePreferredItemLink(titleLink, citekey, itemData, scope);
    itemDiv.createDiv({ cls: "reference-journal", text: `${journal}${journal && issueDate ? ' ' : ''}${issueDate}`.trim() });
  }

  private async renderInlineReferencesSection(
    containerDiv: HTMLElement,
    refs: CollectionData | undefined,
    excludedCitekey?: string,
    options?: {
      referenceFilePath?: string;
      defaultOpen?: boolean;
      emptyMessage?: string;
    }
  ) {
    const citations = this.sortCitations((refs?.citations || []).filter((citekey) => citekey !== excludedCitekey), refs);
    const { file: effectiveReferenceFile, path: effectiveReferenceFilePath } = this.resolveEffectiveReferenceFile(options?.referenceFilePath);
    const { body: sectionBody } = this.createSidebarSection(containerDiv, 'References', {
      sectionKey: 'inline-references',
      contextKey: effectiveReferenceFilePath || refs?.path || this.getCurrentFilePath(),
      meta: `${citations.length} item${citations.length === 1 ? '' : 's'}`,
      defaultOpen: options?.defaultOpen ?? true,
      detailsClass: 'zotsidian-source-inline-references-section',
    });
    const list = sectionBody.createDiv({ cls: 'zotsidian-references-div zotsidian-sidebar-section-list zotsidian-source-inline-references' });
    const selectedContext = effectiveReferenceFilePath ? this.plugin.getSidebarSelectedContext(effectiveReferenceFilePath) : null;
    const selectedCitekeys = new Set(
      (selectedContext?.citekeys || []).map((item) => this.plugin.normalizeCitekeyForInsert(item))
    );
    const primarySelected = selectedContext?.citekeys?.[0]
      ? this.plugin.normalizeCitekeyForInsert(selectedContext.citekeys[0])
      : null;
    const occurrenceTargets = new Map<string, ReferenceLocateTarget[]>();
    const allowLocateTargets = !(effectiveReferenceFile instanceof TFile && effectiveReferenceFile.extension === 'base');
    if (effectiveReferenceFilePath && allowLocateTargets) {
      await Promise.all(citations.map(async (item) => {
        const itemData = (refs?.data.get(item) || {}) as Record<string, unknown>;
        const citekey = typeof itemData['id'] === 'string' && itemData['id'] ? itemData['id'] : item;
        occurrenceTargets.set(citekey, await this.plugin.getReferenceLocateTargetsForFile(effectiveReferenceFilePath, citekey));
      }));
    }

    if (citations.length === 0) {
      list.createDiv({ cls: 'zotsidian-source-empty', text: options?.emptyMessage || 'No inline citations in this document.' });
      return;
    }

    for (const citekey of citations) {
      const itemData = (refs?.data.get(citekey) || {}) as Record<string, unknown>;
      const normalizedCitekey = this.plugin.normalizeCitekeyForInsert(citekey);
      const focusState = primarySelected === normalizedCitekey
        ? 'primary'
        : selectedCitekeys.has(normalizedCitekey)
          ? 'secondary'
          : 'none';
      this.renderReferenceRow(
        list,
        citekey,
        itemData,
        refs?.path || this.plugin.settings.defaultZoteroScope,
        focusState,
        occurrenceTargets.get(citekey) || null,
        effectiveReferenceFilePath
      );
    }
  }

  private findItemDataByCitekey(refs: CollectionData | undefined, citekey: string): Record<string, unknown> | null {
    if (!refs?.data) return null;
    const canonical = this.plugin.normalizeCitekeyForInsert(citekey);
    for (const [key, value] of refs.data.entries()) {
      if (this.plugin.normalizeCitekeyForInsert(key) === canonical) {
        return (value || {}) as Record<string, unknown>;
      }
    }
    return null;
  }

  private async renderDiscourseGraphSection(containerDiv: HTMLElement, referenceFilePath?: string, options?: { defaultOpen?: boolean }) {
    if (!this.plugin.settings.enableDiscourseGraphsCompatibility) return;
    const { file: effectiveReferenceFile, path: effectiveReferenceFilePath } = this.resolveEffectiveReferenceFile(referenceFilePath);
    if (!this.shouldRenderDiscourseGraphPanelForFile(effectiveReferenceFile)) return;
    if (!effectiveReferenceFilePath) return;
    const items = await this.plugin.getDiscourseNodeSidebarItemsForFile(effectiveReferenceFilePath);
    const pinnedItems = this.plugin.getPinnedDiscourseNodes();
    if (items.length === 0 && pinnedItems.length === 0) return;

    const { body: sectionBody } = this.createSidebarSection(containerDiv, 'Discourse Graph', {
      sectionKey: 'discourse-graph',
      contextKey: effectiveReferenceFilePath,
      meta: `${items.length} node${items.length === 1 ? '' : 's'}${pinnedItems.length ? ` · ${pinnedItems.length} pinned` : ''}`,
      defaultOpen: options?.defaultOpen ?? false,
      detailsClass: 'zotsidian-discourse-graph-section',
    });
    const currentItemsById = new Map(items.map((item) => [item.id, item]));
    if (pinnedItems.length > 0) {
      const { body: pinnedBody } = this.createSidebarSection(sectionBody, 'Pinned nodes', {
        sectionKey: 'discourse-graph-pinned',
        contextKey: 'global',
        meta: `${pinnedItems.length} node${pinnedItems.length === 1 ? '' : 's'}`,
        defaultOpen: true,
        detailsClass: 'zotsidian-discourse-graph-pinned',
      });
      const pinnedList = pinnedBody.createDiv({ cls: 'zotsidian-discourse-graph-list' });
      const pinnedTypeNames = Array.from(new Set(pinnedItems.map((item) => (item.nodeTypeName || 'Node').trim()).filter(Boolean)));
      if (pinnedTypeNames.length > 1) {
        const filterBar = pinnedBody.createDiv({ cls: 'zotsidian-discourse-graph-filters' });
        pinnedBody.insertBefore(filterBar, pinnedList);
        const buttons = [
          { value: 'all', label: 'All' },
          ...pinnedTypeNames.map((value) => ({ value, label: value })),
        ].map(({ value, label }) => {
          const button = filterBar.createEl('button', {
            cls: 'zotsidian-discourse-graph-filter',
            text: label,
            attr: { type: 'button', title: label, 'aria-label': label },
          });
          this.stabilizeSidebarControl(button);
          button.dataset.value = value;
          button.addEventListener('click', () => {
            buttons.forEach((entry) => {
              entry.classList.toggle('is-active', (entry.dataset.value || 'all') === value);
            });
            pinnedList.querySelectorAll<HTMLElement>('.zotsidian-discourse-graph-item').forEach((row) => {
              const type = row.dataset.nodeType || 'Node';
              row.classList.toggle('is-filtered-out', value !== 'all' && type !== value);
            });
          });
          return button;
        });
        buttons[0]?.classList.add('is-active');
      }
      for (const item of pinnedItems) {
        const row = pinnedList.createDiv({ cls: 'zotsidian-discourse-graph-item zotsidian-discourse-graph-pinned-item' });
        row.dataset.nodeType = (item.nodeTypeName || 'Node').trim();
        row.setAttribute('aria-label', item.title);
        this.attachDiscourseNodeDrag(row, item);
        this.attachDiscourseNodeHover(row, item);
        const top = row.createDiv({ cls: 'zotsidian-discourse-graph-item-top' });
        const badge = top.createSpan({ cls: 'zotsidian-discourse-graph-type', text: item.nodeTypeName || 'Node' });
        if (item.nodeTypeColor) {
          badge.style.setProperty('--dg-node-type-color', item.nodeTypeColor);
        }
        const titleLink = top.createEl('a', { cls: 'zotsidian-discourse-graph-title', text: item.title });
        titleLink.href = '#';
        titleLink.setAttribute('draggable', 'false');
        titleLink.addEventListener('click', async (evt) => {
          evt.preventDefault();
          evt.stopPropagation();
          if (!item.filePath) return;
          const file = this.plugin.app.vault.getAbstractFileByPath(item.filePath);
          if (file instanceof TFile) {
            await this.plugin.app.workspace.getLeaf(false).openFile(file);
          }
        });
        const actions = top.createSpan({ cls: 'reference-locate-group zotsidian-discourse-graph-locate' });
        const unpinButton = actions.createEl('button', {
          cls: 'reference-locate-button zotsidian-discourse-graph-pin-button is-pinned',
          attr: { type: 'button', title: 'Unpin node', 'aria-label': 'Unpin node' },
        });
        this.stabilizeSidebarControl(unpinButton);
        setIcon(unpinButton, 'pin-off');
        unpinButton.addEventListener('click', async (evt) => {
          evt.preventDefault();
          evt.stopPropagation();
          row.remove();
          await this.plugin.unpinPinnedDiscourseNode(item.id);
          await this.renderReferences();
        });
        const currentItem = currentItemsById.get(item.id);
        currentItem?.targets.forEach((target, index) => {
          const button = actions.createEl('button', {
            cls: 'reference-locate-button',
            text: String(index + 1),
            attr: { type: 'button' },
          });
          this.stabilizeSidebarControl(button);
          button.title = target.kind === 'canvas-discourse-node'
            ? `Jump to canvas node ${index + 1}`
            : target.kind === 'base-node-link'
              ? `Jump to visible node ${index + 1}`
              : `Jump to linked node mention ${index + 1}`;
          button.addEventListener('click', async (evt) => {
            evt.preventDefault();
            evt.stopPropagation();
            const located = await this.plugin.locateDiscourseNodeOccurrence(effectiveReferenceFilePath, item.id, target.id);
            if (!located) {
              new Notice('No discourse node location was found in the active document.');
            }
          });
        });
      }
    }
    let currentNodesBody = sectionBody;
    if (pinnedItems.length > 0 && items.length > 0) {
      const { body } = this.createSidebarSection(sectionBody, 'Current page nodes', {
        sectionKey: 'discourse-graph-current',
        contextKey: effectiveReferenceFilePath,
        meta: `${items.length} node${items.length === 1 ? '' : 's'}`,
        defaultOpen: true,
        detailsClass: 'zotsidian-discourse-graph-current',
      });
      currentNodesBody = body;
    }
    const list = currentNodesBody.createDiv({ cls: 'zotsidian-discourse-graph-list' });
    const typeNames = Array.from(new Set(items.map((item) => (item.nodeTypeName || 'Node').trim()).filter(Boolean)));
    let activeTypeFilter = 'all';
    if (typeNames.length > 1) {
      const filterBar = currentNodesBody.createDiv({ cls: 'zotsidian-discourse-graph-filters' });
      currentNodesBody.appendChild(filterBar);
      currentNodesBody.appendChild(list);
      const buttons = [
        { value: 'all', label: 'All' },
        ...typeNames.map((value) => ({ value, label: value })),
      ].map(({ value, label }) => {
        const button = filterBar.createEl('button', {
          cls: 'zotsidian-discourse-graph-filter',
          text: label,
          attr: { type: 'button', title: label, 'aria-label': label },
        });
        this.stabilizeSidebarControl(button);
        button.dataset.value = value;
        button.addEventListener('click', () => {
          activeTypeFilter = value;
          buttons.forEach((entry) => {
            entry.classList.toggle('is-active', (entry.dataset.value || 'all') === activeTypeFilter);
          });
          list.querySelectorAll<HTMLElement>('.zotsidian-discourse-graph-item').forEach((row) => {
            const type = row.dataset.nodeType || 'Node';
            row.classList.toggle('is-filtered-out', activeTypeFilter !== 'all' && type !== activeTypeFilter);
          });
        });
        return button;
      });
      buttons[0]?.classList.add('is-active');
    }
    const focusedNodeIds = new Set(this.plugin.getSidebarFocusedDiscourseNodes(effectiveReferenceFilePath));

    for (const item of items) {
      const row = list.createDiv({ cls: 'zotsidian-discourse-graph-item' });
      row.dataset.nodeType = (item.nodeTypeName || 'Node').trim();
      if (focusedNodeIds.has(item.id)) {
        row.addClass('is-focused');
        row.addClass('is-focused-primary');
      }
      row.setAttribute('aria-label', item.title);
      this.attachDiscourseNodeDrag(row, item);
      this.attachDiscourseNodeHover(row, item);
      const top = row.createDiv({ cls: 'zotsidian-discourse-graph-item-top' });
      const badge = top.createSpan({ cls: 'zotsidian-discourse-graph-type', text: item.nodeTypeName || 'Node' });
      if (item.nodeTypeColor) {
        badge.style.setProperty('--dg-node-type-color', item.nodeTypeColor);
      }
      const titleLink = top.createEl('a', { cls: 'zotsidian-discourse-graph-title', text: item.title });
      titleLink.href = '#';
      titleLink.setAttribute('draggable', 'false');
      row.addEventListener('click', (evt) => {
        const target = evt.target;
        if (target instanceof HTMLElement && (target.closest('button') || target.closest('a'))) return;
        row.classList.toggle('is-expanded');
      });
      titleLink.addEventListener('click', async (evt) => {
        evt.preventDefault();
        evt.stopPropagation();
        if (!item.filePath) return;
        const file = this.plugin.app.vault.getAbstractFileByPath(item.filePath);
        if (file instanceof TFile) {
          await this.plugin.app.workspace.getLeaf(false).openFile(file);
        }
      });

      const locateWrap = top.createSpan({ cls: 'reference-locate-group zotsidian-discourse-graph-locate' });
      const pinButton = locateWrap.createEl('button', {
        cls: `reference-locate-button zotsidian-discourse-graph-pin-button${this.plugin.isDiscourseNodePinned(item.id) ? ' is-pinned' : ''}`,
        attr: {
          type: 'button',
          title: this.plugin.isDiscourseNodePinned(item.id) ? 'Unpin node' : 'Pin node',
          'aria-label': this.plugin.isDiscourseNodePinned(item.id) ? 'Unpin node' : 'Pin node',
        },
      });
      this.stabilizeSidebarControl(pinButton);
      setIcon(pinButton, this.plugin.isDiscourseNodePinned(item.id) ? 'pin-off' : 'pin');
      pinButton.addEventListener('click', async (evt) => {
        evt.preventDefault();
        evt.stopPropagation();
        const pinned = await this.plugin.togglePinnedDiscourseNode(item);
        new Notice(pinned ? 'Discourse node pinned.' : 'Discourse node unpinned.');
        await this.renderReferences();
      });
      item.targets.forEach((target, index) => {
        const button = locateWrap.createEl('button', {
          cls: 'reference-locate-button',
          text: String(index + 1),
          attr: { type: 'button' },
        });
        this.stabilizeSidebarControl(button);
        button.title = target.kind === 'canvas-discourse-node'
          ? `Jump to canvas node ${index + 1}`
          : target.kind === 'base-node-link'
            ? `Jump to visible node ${index + 1}`
            : `Jump to linked node mention ${index + 1}`;
        button.addEventListener('click', async (evt) => {
          evt.preventDefault();
          evt.stopPropagation();
          const located = await this.plugin.locateDiscourseNodeOccurrence(effectiveReferenceFilePath, item.id, target.id);
          if (!located) {
            new Notice('No discourse node location was found in the active document.');
          }
        });
      });
    }
  }

  private scrollFocusedReferenceIntoView() {
    const focused = this.contentEl.querySelector<HTMLElement>('.reference-div.is-focused-primary, .reference-div.is-focused, .zotsidian-discourse-graph-item.is-focused-primary, .zotsidian-discourse-graph-item.is-focused');
    if (!focused) return;
    window.requestAnimationFrame(() => {
      focused.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
  }

  setHeader(header: HTMLElement, scope?: string, detectedMentions: number = 0){
    this.buildHeader(header, 'REFERENCES', scope, detectedMentions, this.activeFileCollectionData?.path || scope);

  }

  setViewContent(content: HTMLElement, scope?: string, detectedMentions: number = 0) {
    this.hideReferenceHoverCard();
    this.contentEl.empty();
    const containerDiv = this.contentEl.createDiv({cls:"zotsidian-container-div" });
    this.setHeader(containerDiv, scope, detectedMentions);
    this.maybeRenderDiscourseCompatibilityHint(containerDiv, 'references');

    if (!content) {
      this.setEmptyView();
    } else {
      containerDiv.appendChild(content);
      this._lastRenderedFilePath = this.getCurrentFilePath() || null;
      this._lastRenderedMode = 'references';
    }
  }

  setErrorView(error?: Error, scope?: string, detectedMentions: number = 0) {
    this.hideReferenceHoverCard();
    
    this.contentEl.empty();
    
    const containerDiv = this.contentEl.createDiv({cls:"zotsidian-container-div" });
    
    this.setHeader(containerDiv, scope, detectedMentions);
    this.maybeRenderDiscourseCompatibilityHint(containerDiv, 'error');

    const status = this.plugin.getCitationIndexStatus(scope);
    const message = error?.message === 'net::ERR_CONNECTION_REFUSED'
      ? 'Unable to connect to Zotero. Is Zotero running?'
      : (status.errorText || error?.message || 'Unknown references error.');
    containerDiv.createDiv({
      cls: 'pane-empty',
      text: message,
    });
    this._lastRenderedFilePath = this.getCurrentFilePath() || null;
    this._lastRenderedMode = 'error';
  }

  setEmptyView(scope?: string, detectedMentions: number = 0, message: string = 'No citations found in the current document.') {
    this.hideReferenceHoverCard();
    this.contentEl.empty();
    const containerDiv = this.contentEl.createDiv({cls:"zotsidian-container-div" });
    this.setHeader(containerDiv, scope, detectedMentions);
    this.maybeRenderDiscourseCompatibilityHint(containerDiv, 'empty');
    containerDiv.createDiv({
      cls: 'pane-empty',
      text: message,
    });
    this._lastRenderedFilePath = this.getCurrentFilePath() || null;
    this._lastRenderedMode = 'empty';

  }

  setLoadingView(scope?: string, detectedMentions: number = 0) {
    this.hideReferenceHoverCard();
    const currentPath = this.getCurrentFilePath();
    if (
      currentPath &&
      this._lastRenderedFilePath === currentPath &&
      this._lastRenderedMode &&
      this.contentEl.childElementCount > 0
    ) {
      this.refreshHeaderStatus(scope, detectedMentions);
      return;
    }

    this.contentEl.empty();
    const containerDiv = this.contentEl.createDiv({cls:"zotsidian-container-div" });
    this.setHeader(containerDiv, scope, detectedMentions);
    this.maybeRenderDiscourseCompatibilityHint(containerDiv, 'loading');

    //emptyDiv with loading spinner
    const empty = containerDiv.createDiv({ cls: 'pane-empty' });
    empty.createEl("span", {cls: "loader-spinner"});
    this._lastRenderedFilePath = currentPath || null;
    this._lastRenderedMode = null;
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

		const activeFile = this.getCurrentFile();

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

		const activeFile = this.getCurrentFile();

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
    const { file: effectiveReferenceFile, path: effectiveReferenceFilePath } = this.resolveEffectiveReferenceFile(this.getCurrentFilePath());
    const activeCache = effectiveReferenceFile ? this.plugin.app.metadataCache.getFileCache(effectiveReferenceFile) : null;
    const activeScope = this.plugin.resolveScopeFromFrontmatter(activeCache?.frontmatter as Record<string, unknown> | undefined);
    this.setLoadingView(activeScope);

    const sourceCitekey = this.getActiveSourceCitekey();
    if (sourceCitekey) {
      const refs = await this.processReferences();
      await this.renderSourceInspector(sourceCitekey, refs);
      return;
    }

    const refs = await this.processReferences();
    const containerDiv = document.createElement('div');
    containerDiv.classList.add('zotsidian-references-div');
    
    if (!refs.citations || refs.citations.length ==0){
      await this.renderDiscourseGraphSection(containerDiv, effectiveReferenceFilePath, { defaultOpen: true });
      await this.renderInlineReferencesSection(containerDiv, refs, undefined, {
        referenceFilePath: effectiveReferenceFilePath,
        defaultOpen: true,
      });
      const hasSupplementarySections = containerDiv.childElementCount > 0;
      if ('error' in refs) {
        if (hasSupplementarySections) {
          containerDiv.createDiv({
            cls: 'pane-empty',
            text: refs.error?.message || 'Unable to resolve inline citations in this view.',
          });
          this.setViewContent(containerDiv, refs.path, refs.detectedCitations?.length || 0);
          return;
        }
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
        if (hasSupplementarySections) {
          containerDiv.createDiv({ cls: 'pane-empty', text: message });
          this.setViewContent(containerDiv, refs.path, refs.detectedCitations?.length || 0);
          return;
        }
        this.setEmptyView(refs.path, refs.detectedCitations?.length || 0, message);
      } else {
        if (hasSupplementarySections) {
          containerDiv.createDiv({
            cls: 'pane-empty',
            text: 'No inline citations found in this document. Other discourse items found here are shown above.',
          });
          this.setViewContent(containerDiv, refs.path, 0);
          return;
        }
        this.setEmptyView(refs.path, 0);
      };
      return
    }
    
    await this.renderDiscourseGraphSection(containerDiv, effectiveReferenceFilePath, { defaultOpen: true });
    await this.renderInlineReferencesSection(containerDiv, refs, undefined, {
      referenceFilePath: effectiveReferenceFilePath,
      defaultOpen: true,
    });
  

    this.setViewContent(containerDiv, refs.path, refs.detectedCitations?.length || refs.citations.length);
    this.scrollFocusedReferenceIntoView();

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
      zoteroDataDir: this.plugin.settings.zoteroDataDir || undefined,
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
