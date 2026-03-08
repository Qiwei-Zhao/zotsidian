import {
	App,
	Editor,
	EditorPosition,
	EditorSuggest,
	EditorSuggestContext,
	EditorSuggestTriggerInfo,
	TFile,
} from 'obsidian';

import { FrontMatterScopeProperty } from 'FrontMatter'

import ZotsidianPlugin from 'main';

interface Suggestion {
	id: string;
	title: string;
	meta?: string;
	raw?: Record<string, unknown>;
}


export class CitationSuggest extends EditorSuggest<Suggestion> {
	readonly app: App;
	private plugin: ZotsidianPlugin;
	private justCompleted: boolean;
	private zotero_collection: string;

	constructor(app: App, plugin: ZotsidianPlugin) {
		super(app);
		this.app = app;
		this.plugin = plugin;
		this.justCompleted = false;
	}

	onTrigger(
		cursor: EditorPosition,
		editor: Editor,
		file: TFile
	): EditorSuggestTriggerInfo | null {

		if (this.justCompleted) {
			this.justCompleted = false;
			return null;
		}
		const lineToCursor = editor.getRange(
			{ line: cursor.line, ch: 0 },
			{ line: cursor.line, ch: cursor.ch },
		);

		const match = lineToCursor.match(/(?:^|[\s([{"'“‘])@([A-Za-z0-9._:-]*)$/);
		if (!match) {
			return null;
		}

		const query = match[1] ?? '';
		const queryStartPos = {
			line: cursor.line,
			ch: cursor.ch - query.length - 1,
		};

		const noteFile = file;
		const frontMatter = this.app.metadataCache.getFileCache(noteFile)?.frontmatter;
		const frontmatterBib = frontMatter?.[FrontMatterScopeProperty];
		const fallbackBib = this.plugin.resolveScopeFromFrontmatter(frontMatter as Record<string, unknown> | undefined);
		this.zotero_collection = (typeof frontmatterBib === 'string' && frontmatterBib.trim().length > 0) ? frontmatterBib.trim() : fallbackBib;
	

		return {
			start: queryStartPos,
			end: cursor,
			query: query,
		};

	    }

	async getSuggestions(context: EditorSuggestContext): Promise<Suggestion[]> {

		if (!this.zotero_collection) {
			return [];
		}

		const query = context.query ?? '';
		const minChars = this.plugin.settings.autocompleteMinQueryLength || 2;
		if (query.trim().length < minChars) {
			return [];
		}
		return await this.plugin.searchCitationIndex(this.zotero_collection, query, 40) as Suggestion[];
	    }

	renderSuggestion(suggestion: Suggestion, el: HTMLElement): void {
		el.empty();
		const meta = suggestion.meta ? `${suggestion.meta}  ` : '';
		const shownId = this.plugin.normalizeCitekeyForInsert(suggestion.id);
		const primary = document.createElement('div');
		primary.className = 'zotsidian-suggest-primary';
		primary.textContent = `${meta}@${shownId}`;
		const secondary = document.createElement('div');
		secondary.className = 'zotsidian-suggest-secondary';
		secondary.textContent = suggestion.title ?? '';
		el.appendChild(primary);
		el.appendChild(secondary);
	}

	private buildInsertionForContext(citekey: string, precedingChar: string, precedingTwoChars: string, followingChar: string, followingTwoChars: string): string {
		const format = this.plugin.settings.citationInsertFormat;
		const normalized = this.plugin.normalizeCitekeyForInsert(citekey);
		if (format === 'plain') {
			return `@${normalized}`;
		}
		if (format === 'wikilink') {
			if (precedingTwoChars === '[[') {
				if (followingTwoChars === ']]') return `@${normalized}`;
				if (followingChar === ']') return `@${normalized}]`;
				return `@${normalized}]]`;
			}
			return this.plugin.buildCitationInsertion(normalized, 'wikilink');
		}
		if (precedingChar === '[') {
			if (followingChar === ']') return `@${normalized}`;
			return `@${normalized}]`;
		}
		return this.plugin.buildCitationInsertion(normalized, 'pandoc');
	}

	selectSuggestion(suggestion: Suggestion, event: KeyboardEvent | MouseEvent): void {

		if (this.context){

			const { editor } = this.context;

			/*
			const precedingChar = editor.getRange({line: this.context.start.line, ch: this.context.start.ch - 1},
												  {line: this.context.start.line, ch: this.context.start.ch});
			*/
			
			const precedingChar = this.context.start.ch > 0
				? editor.getRange(
					{ line: this.context.start.line, ch: this.context.start.ch - 1 },
					{ line: this.context.start.line, ch: this.context.start.ch },
				  )
				: '';
			const precedingTwoChars = this.context.start.ch > 1
				? editor.getRange(
					{ line: this.context.start.line, ch: this.context.start.ch - 2 },
					{ line: this.context.start.line, ch: this.context.start.ch },
				  )
				: precedingChar;
			const followingChar = editor.getRange(
				{ line: this.context.start.line, ch: this.context.end.ch },
				{ line: this.context.start.line, ch: this.context.end.ch + 1 }
			);
			const followingTwoChars = editor.getRange(
				{ line: this.context.start.line, ch: this.context.end.ch },
				{ line: this.context.start.line, ch: this.context.end.ch + 2 }
			);
	
	
			const insertedId = this.plugin.normalizeCitekeyForInsert(suggestion.id);
			const replaceEnd = { line: this.context.end.line, ch: this.context.end.ch };
			const suggStr = this.buildInsertionForContext(insertedId, precedingChar, precedingTwoChars, followingChar, followingTwoChars);
			const cursorEndPos = this.context.start.ch + suggStr.length;
	
			editor.replaceRange(suggStr, this.context.start, replaceEnd);
	
			editor.setCursor({'line': this.context.start.line, 'ch': cursorEndPos})

			void this.plugin.ensureSourcePageForCitekey(insertedId, suggestion.title, suggestion.raw);
	
			this.justCompleted = true;
	
		}

	}

}
