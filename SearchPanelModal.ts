import { App, MarkdownView, Notice, SuggestModal, setIcon } from "obsidian";
import ZotsidianPlugin, { CitationIndexEntry } from "main";
import { attachments, type AttachmentLookupHint } from "ZoteroFunctions";

export class SearchPanelModal extends SuggestModal<CitationIndexEntry> {
	private readonly plugin: ZotsidianPlugin;
	private readonly collectionPath: string;
	private readonly maxResults: number;

	constructor(app: App, plugin: ZotsidianPlugin, scope: string, maxResults = 80) {
		super(app);
		this.plugin = plugin;
		this.collectionPath = scope;
		this.maxResults = maxResults;
		this.setPlaceholder("Search title, author, year, citekey...");
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

	getSuggestions(query: string): CitationIndexEntry[] | Promise<CitationIndexEntry[]> {
		const q = query.trim();
		if (q.length < (this.plugin.settings.autocompleteMinQueryLength || 2)) {
			return [];
		}
		return this.plugin.searchCitationIndex(this.collectionPath, q, this.maxResults);
	}

	private normalizeItemKey(raw: Record<string, unknown>): string | undefined {
		const direct = typeof raw.itemKey === 'string' ? raw.itemKey : (typeof raw['zotero-key'] === 'string' ? raw['zotero-key'] : '');
		if (direct && /^[A-Z0-9]{8}$/i.test(direct)) return direct.toUpperCase();
		for (const value of [raw.zoteroItemID, raw.zotero, raw.id]) {
			if (typeof value !== 'string') continue;
			const matched = value.match(/items\/([A-Z0-9]{8})/i);
			if (matched?.[1]) return matched[1].toUpperCase();
		}
		return undefined;
	}

	private zoteroUriFromRaw(raw: Record<string, unknown>): string {
		if (typeof raw.zotero === 'string' && raw.zotero.startsWith('zotero://')) return raw.zotero;
		if (typeof raw.zoteroItemID === 'string' && raw.zoteroItemID.startsWith('zotero://')) return raw.zoteroItemID;
		if (typeof raw.zoteroItemID === 'string') {
			const groupMatch = raw.zoteroItemID.match(/\/groups\/([0-9]+)\/items\/([A-Z0-9]{8})/i);
			if (groupMatch?.[1] && groupMatch?.[2]) return `zotero://select/groups/${groupMatch[1]}/items/${groupMatch[2]}`;
			const userMatch = raw.zoteroItemID.match(/\/users\/([0-9]+)\/items\/([A-Z0-9]{8})/i);
			if (userMatch?.[2]) return `zotero://select/library/items/${userMatch[2]}`;
		}
		const itemKey = this.normalizeItemKey(raw);
		return itemKey ? `zotero://select/library/items/${itemKey}` : '';
	}

	private async openPreferredPdf(item: CitationIndexEntry, shownId: string) {
		const raw = item.raw || {};
		const hint: AttachmentLookupHint = {
			itemKey: this.normalizeItemKey(raw),
			zoteroItemID: typeof raw.zoteroItemID === 'string' ? raw.zoteroItemID : undefined,
			zotero: typeof raw.zotero === 'string' ? raw.zotero : undefined,
			citekey: typeof raw.id === 'string' ? raw.id : shownId,
			doi: typeof raw.DOI === 'string' ? raw.DOI : undefined,
			title: typeof raw.title === 'string' ? raw.title : undefined,
			zoteroDataDir: this.plugin.settings.zoteroDataDir || undefined,
		};
		try {
			const rows = await attachments(shownId, this.collectionPath.split('/')[0] || this.collectionPath, hint);
			const attachmentRows = Array.isArray(rows) ? rows : [];
			const pdf = attachmentRows.find((row: any) => typeof row?.open === 'string' && row.open.startsWith('zotero://open-pdf/'))
				|| attachmentRows.find((row: any) => typeof row?.open === 'string' && row.open.length > 0);
			if (pdf?.open) {
				this.openLinkTarget(pdf.open);
				return;
			}
		} catch (_err) {
			// handled below
		}
		new Notice('No PDF or attachment was found for this item.');
	}

	renderSuggestion(item: CitationIndexEntry, el: HTMLElement): void {
		el.empty();
		const meta = item.meta ? `${item.meta}  ` : "";
		const shownId = this.plugin.normalizeCitekeyForInsert(item.id);
		const topRow = el.createDiv({ cls: "zotsidian-suggest-row" });
		const primary = topRow.createDiv({ cls: "zotsidian-suggest-primary" });
		if (meta) {
			primary.createSpan({ cls: "zotsidian-suggest-meta", text: meta });
		}
		const citekeyWrap = primary.createDiv({ cls: 'zotsidian-suggest-citekey-wrap' });
		const citekeyEl = citekeyWrap.createSpan({ cls: "zotsidian-suggest-citekey", text: `@${shownId}` });
		citekeyEl.setAttribute('title', `@${shownId}`);
		const actions = topRow.createDiv({ cls: "zotsidian-suggest-actions" });
		el.createDiv({ cls: "zotsidian-suggest-secondary", text: item.title || "" });
		const existingSource = this.plugin.findSourceNoteFile(shownId);
		if (existingSource) {
			citekeyEl.addClass('has-source-page');
			citekeyEl.setAttribute('title', 'Source page exists');
		}

		const makeButton = (icon: string, label: string, kind: 'source' | 'zotero' | 'pdf', onClick: () => void) => {
			const button = actions.createEl('button', {
				cls: `zotsidian-suggest-action is-${kind}`,
				attr: { type: 'button', 'aria-label': label, title: label },
			});
			const iconEl = button.createSpan({ cls: 'zotsidian-suggest-action-icon' });
			setIcon(iconEl, icon);
			button.addEventListener('click', (evt) => {
				evt.preventDefault();
				evt.stopPropagation();
				onClick();
			});
			return button;
		};

		makeButton(existingSource ? 'folder-open' : 'folder-plus', existingSource ? 'Open source page' : 'Create source page', 'source', () => {
			void this.plugin.openOrCreateSourcePage(shownId, item.title, item.raw);
		});

		if (this.zoteroUriFromRaw(item.raw)) {
			makeButton('external-link', 'Open in Zotero', 'zotero', () => this.openLinkTarget(this.zoteroUriFromRaw(item.raw)));
			makeButton('file-search', 'Open PDF', 'pdf', () => {
				void this.openPreferredPdf(item, shownId);
			});
		} else {
			actions.createSpan({ cls: "zotsidian-suggest-action-hint", text: "Insert" });
		}
	}

	async onChooseSuggestion(item: CitationIndexEntry): Promise<void> {
		const insertedId = this.plugin.normalizeCitekeyForInsert(item.id);
		const citationText = this.plugin.buildCitationInsertion(insertedId);
		const markdownView = this.app.workspace.getActiveViewOfType(MarkdownView);
		const editor = markdownView?.editor;
		if (editor) {
			editor.replaceSelection(citationText);
		} else {
			await navigator.clipboard.writeText(citationText);
			new Notice(`Copied ${citationText}`);
		}
		await this.plugin.ensureSourcePageForCitekey(insertedId, item.title, item.raw);
	}
}
