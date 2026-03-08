import { App, MarkdownView, Notice, SuggestModal } from "obsidian";
import ZotsidianPlugin, { CitationIndexEntry } from "main";

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

	getSuggestions(query: string): CitationIndexEntry[] | Promise<CitationIndexEntry[]> {
		const q = query.trim();
		if (q.length < (this.plugin.settings.autocompleteMinQueryLength || 2)) {
			return [];
		}
		return this.plugin.searchCitationIndex(this.collectionPath, q, this.maxResults);
	}

	renderSuggestion(item: CitationIndexEntry, el: HTMLElement): void {
		el.empty();
		const meta = item.meta ? `${item.meta}  ` : "";
		const shownId = this.plugin.normalizeCitekeyForInsert(item.id);
		el.createDiv({ cls: "zotsidian-suggest-primary", text: `${meta}@${shownId}` });
		el.createDiv({ cls: "zotsidian-suggest-secondary", text: item.title || "" });
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
