import { App, Plugin, PluginSettingTab, Setting, TFile, WorkspaceLeaf, normalizePath } from 'obsidian';

import { CitationSuggest } from "CitationSuggest";
import { ReferencesView, ReferencesViewType } from 'ReferencesView';
import { SearchPanelModal } from 'SearchPanelModal';
import { FrontMatterScopeProperty } from 'FrontMatter';
import { createCitationHoverCardElement, createCitationHoverExtension } from 'EditorExtensions';
import { attachments, exportCollectionPath, normalizeExportItems, libraryCitekeysTitles, locateCollection, localApiLibraryIndex, resolveCitekeysToItems, resolveCitekeysToItemsViaLocalApi, type AttachmentLookupHint } from 'ZoteroFunctions';
import { fetchSourceRelatedPapers, normalizeDoi, type SemanticRelatedPaper, type RelatedPapersProvider } from 'SemanticScholar';
import { citationsInText } from 'ReferenceProcessing';

export interface CitationIndexEntry {
	id: string;
	title: string;
	meta: string;
	raw: Record<string, unknown>;
}

export type CitationInsertFormat = 'pandoc' | 'plain' | 'wikilink';
export type CitationHoverOpenAction = 'pdf-first' | 'zotero-first';
export type CitationConnectionState = 'unknown' | 'connecting' | 'connected' | 'degraded' | 'disconnected';
export type CitationIndexSource = 'memory' | 'disk' | 'live-export' | 'local-api' | 'json-fallback' | 'none';

interface ZotsidianSettings {
	defaultZoteroScope: string;
	localLibraryJsonPath: string;
	autocompleteMinQueryLength: number;
	searchPanelMaxResults: number;
	normalizeCitekeyOnInsert: boolean;
	preloadIndexOnStartup: boolean;
	indexRefreshMinutes: number;
	autoBootstrapSourcePages: boolean;
	autoCreateSourceOnCitationSelect: boolean;
	sourceNotesFolderPath: string;
	sourceTemplatePath: string;
	enableSidebarAttachments: boolean;
	showSourceRelatedPapers: boolean;
	relatedPapersProvider: RelatedPapersProvider;
	citationInsertFormat: CitationInsertFormat;
	showCitationHoverCard: boolean;
	citationHoverOpenAction: CitationHoverOpenAction;
	showJsonFallbackSettingInAdvanced: boolean;
}

type PersistedCitationIndexCache = {
	rows: CitationIndexEntry[];
	cachedAt: number;
	source: Exclude<CitationIndexSource, 'memory' | 'disk' | 'none'>;
};

type InternalPluginState = {
	citationIndexCacheByScope: Record<string, PersistedCitationIndexCache>;
};

type ZotsidianStoredData = Partial<ZotsidianSettings> & {
	_internal?: Partial<InternalPluginState>;
};

const DEFAULT_SETTINGS: ZotsidianSettings = {
	defaultZoteroScope: 'My Library',
	localLibraryJsonPath: 'My Library.json',
	autocompleteMinQueryLength: 2,
	searchPanelMaxResults: 80,
	normalizeCitekeyOnInsert: true,
	preloadIndexOnStartup: true,
	indexRefreshMinutes: 15,
	autoBootstrapSourcePages: true,
	autoCreateSourceOnCitationSelect: false,
	sourceNotesFolderPath: 'source',
	sourceTemplatePath: '',
	enableSidebarAttachments: true,
	showSourceRelatedPapers: true,
	relatedPapersProvider: 'auto',
	citationInsertFormat: 'pandoc',
	showCitationHoverCard: true,
	citationHoverOpenAction: 'pdf-first',
	showJsonFallbackSettingInAdvanced: true,
};

class ZotsidianSettingTab extends PluginSettingTab {
	plugin: ZotsidianPlugin;

	constructor(app: App, plugin: ZotsidianPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl('h2', { text: 'Zotsidian Settings' });

		containerEl.createEl('h3', { text: 'Index' });

		new Setting(containerEl)
			.setName('Default Zotero scope')
			.setDesc('Used when a note has no bib property. Example: My Library or My Library/Collection.')
			.addText((text) => {
				text
					.setPlaceholder('My Library')
					.setValue(this.plugin.settings.defaultZoteroScope)
					.onChange(async (value) => {
						this.plugin.settings.defaultZoteroScope = value?.trim() || 'My Library';
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName('Preload index on startup')
			.setDesc('Build the local citation index in memory on startup for faster autocomplete.')
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.preloadIndexOnStartup)
					.onChange(async (value) => {
						this.plugin.settings.preloadIndexOnStartup = value;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName('Index refresh (minutes)')
			.setDesc('Background refresh interval for the citation index. Set 0 to disable.')
			.addText((text) => {
				text
					.setPlaceholder('15')
					.setValue(String(this.plugin.settings.indexRefreshMinutes))
					.onChange(async (value) => {
						const n = Number(value);
						this.plugin.settings.indexRefreshMinutes = Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 15;
						await this.plugin.saveSettings();
					});
			});

		containerEl.createEl('h3', { text: 'Inline Citations' });

		new Setting(containerEl)
			.setName('Autocomplete min query length')
			.setDesc('Inline citation suggestions start after this many characters.')
			.addText((text) => {
				text
					.setPlaceholder('2')
					.setValue(String(this.plugin.settings.autocompleteMinQueryLength))
					.onChange(async (value) => {
						const n = Number(value);
						this.plugin.settings.autocompleteMinQueryLength = Number.isFinite(n) ? Math.max(1, Math.min(4, Math.floor(n))) : 2;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName('Search panel max results')
			.setDesc('Maximum number of records shown in the search panel.')
			.addText((text) => {
				text
					.setPlaceholder('80')
					.setValue(String(this.plugin.settings.searchPanelMaxResults))
					.onChange(async (value) => {
						const n = Number(value);
						this.plugin.settings.searchPanelMaxResults = Number.isFinite(n) ? Math.max(20, Math.min(300, Math.floor(n))) : 80;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName('Normalize citekey on insert')
			.setDesc('Remove dots and special symbols when inserting citekeys.')
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.normalizeCitekeyOnInsert)
					.onChange(async (value) => {
						this.plugin.settings.normalizeCitekeyOnInsert = value;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName('Citation insert format')
			.setDesc('Choose how inserted citations are written in the editor.')
			.addDropdown((dropdown) => {
				dropdown
					.addOption('pandoc', '[@citekey]')
					.addOption('plain', '@citekey')
					.addOption('wikilink', '[[@citekey]]')
					.setValue(this.plugin.settings.citationInsertFormat)
					.onChange(async (value) => {
						this.plugin.settings.citationInsertFormat = value as CitationInsertFormat;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName('Create source page on citation select')
			.setDesc('When selecting a citation suggestion, ensure the matching @citekey source page exists.')
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.autoCreateSourceOnCitationSelect)
					.onChange(async (value) => {
						this.plugin.settings.autoCreateSourceOnCitationSelect = value;
						await this.plugin.saveSettings();
					});
			});

		containerEl.createEl('h3', { text: 'Source Pages' });

		new Setting(containerEl)
			.setName('Auto-update source page metadata')
			.setDesc('When opening a note named @citekey, refresh its source metadata automatically.')
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.autoBootstrapSourcePages)
					.onChange(async (value) => {
						this.plugin.settings.autoBootstrapSourcePages = value;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName('Source pages folder')
			.setDesc('Folder where @source pages are stored.')
			.addText((text) => {
				text
					.setPlaceholder('source')
					.setValue(this.plugin.settings.sourceNotesFolderPath)
					.onChange(async (value) => {
						this.plugin.settings.sourceNotesFolderPath = value?.trim() || 'source';
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName('Source page template path')
			.setDesc('Optional template used to fill and update source page properties. Leave empty to use built-in defaults only.')
			.addText((text) => {
				text
					.setPlaceholder('Optional')
					.setValue(this.plugin.settings.sourceTemplatePath)
					.onChange(async (value) => {
						this.plugin.settings.sourceTemplatePath = value?.trim() || '';
						await this.plugin.saveSettings();
					});
			});

		containerEl.createEl('h3', { text: 'Panels' });

		new Setting(containerEl)
			.setName('Load attachment links in source panel')
			.setDesc('Show PDF or attachment links and local Zotero annotations in the source sidebar.')
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.enableSidebarAttachments)
					.onChange(async (value) => {
						this.plugin.settings.enableSidebarAttachments = value;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName('Show citation hover card')
			.setDesc('Hover a citation mention in the editor to preview metadata and open PDF, Zotero, or the source page.')
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.showCitationHoverCard)
					.onChange(async (value) => {
						this.plugin.settings.showCitationHoverCard = value;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName('Hover card primary action')
			.setDesc('Choose whether hover cards prefer opening a PDF or the Zotero item first.')
			.addDropdown((dropdown) => {
				dropdown
					.addOption('pdf-first', 'PDF first')
					.addOption('zotero-first', 'Zotero first')
					.setValue(this.plugin.settings.citationHoverOpenAction)
					.onChange(async (value) => {
						this.plugin.settings.citationHoverOpenAction = value as CitationHoverOpenAction;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName('Show related papers in source panel')
			.setDesc('Show references, citations, and related library items in the source sidebar.')
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.showSourceRelatedPapers)
					.onChange(async (value) => {
						this.plugin.settings.showSourceRelatedPapers = value;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName('Related papers provider')
			.setDesc('Recommended: Auto. It tries Semantic Scholar first, then falls back to OpenAlex when Semantic Scholar is rate-limited or incomplete.')
			.addDropdown((dropdown) => {
				dropdown
					.addOption('auto', 'Auto (Recommended)')
					.addOption('semantic-scholar', 'Semantic Scholar only')
					.addOption('openalex', 'OpenAlex only')
					.setValue(this.plugin.settings.relatedPapersProvider)
					.onChange(async (value) => {
						this.plugin.settings.relatedPapersProvider = value as RelatedPapersProvider;
						await this.plugin.saveSettings();
					});
			});

		if (this.plugin.settings.showJsonFallbackSettingInAdvanced) {
			containerEl.createEl('h3', { text: 'Advanced' });

			new Setting(containerEl)
				.setName('Local JSON fallback path')
				.setDesc('Optional Better BibTeX JSON export used only when live Zotero lookup is incomplete.')
				.addText((text) => {
					text
						.setPlaceholder('My Library.json')
						.setValue(this.plugin.settings.localLibraryJsonPath)
						.onChange(async (value) => {
							this.plugin.settings.localLibraryJsonPath = value?.trim() || 'My Library.json';
							await this.plugin.saveSettings();
						});
				});
		}
	}
}

export type SourceRelatedMatch = {
	citekey: string;
	title: string;
	meta: string;
	raw: Record<string, unknown>;
	sourceNotePath: string | null;
};

export type SourceRelatedEntry = {
	relation: 'reference' | 'citation';
	title: string;
	venue: string;
	year: number | null;
	doi: string;
	url: string;
	authors: string[];
	localMatch: SourceRelatedMatch | null;
};

export type SourceRelatedLibraryItem = {
	citekey: string;
	title: string;
	meta: string;
	sourceNotePath: string | null;
	raw: Record<string, unknown>;
	relations: Array<'reference' | 'citation'>;
};

export type SourceRelatedData = {
	doi: string;
	title: string;
	referenceCount: number;
	citationCount: number;
	references: SourceRelatedEntry[];
	citations: SourceRelatedEntry[];
	relatedLibraryItems: SourceRelatedLibraryItem[];
	connectedPapersUrl: string;
	semanticScholarUrl: string;
	googleScholarUrl: string;
	lookupMode: 'doi' | 'title' | 'unavailable';
	provider: 'semantic-scholar' | 'openalex' | 'none';
	note: string;
};

export type CitationHoverData = {
	citekey: string;
	title: string;
	authors: string[];
	journal: string;
	year: string;
	doi: string;
	sourceNotePath: string | null;
	zoteroUri: string | null;
	pdfUri: string | null;
	attachments: Array<{ label: string; open: string }>;
	inLibrary: boolean;
};

export type CitationIndexStatus = {
	scope: string;
	connection: CitationConnectionState;
	rows: number;
	source: CitationIndexSource;
	loading: boolean;
	stale: boolean;
	lastRefreshedAt: number | null;
	cachedAt: number | null;
	errorText: string;
};

export default class ZotsidianPlugin extends Plugin {
	settings: ZotsidianSettings;
	_activeFilePath: string = '';

	private _indexByScope: Map<string, CitationIndexEntry[]> = new Map();
	private _indexPromiseByScope: Map<string, Promise<CitationIndexEntry[]>> = new Map();
	private _indexStatusByScope: Map<string, CitationIndexStatus> = new Map();
	private _discourseConfigLoaded: boolean = false;
	private _discourseSourceNodeTypeId: string | null = null;
	private _discourseNodesFolderPath: string = 'discourse_graph_nodes';
	private _relatedDataCache: Map<string, Promise<SourceRelatedData | null>> = new Map();
	private _hoverDataCache: Map<string, Promise<CitationHoverData | null>> = new Map();
	private _baseViewObserver: MutationObserver | null = null;
	private _baseViewRefreshTimer: number | null = null;
	private _baseHoverCardEl: HTMLElement | null = null;
	private _baseHoverTargetEl: HTMLElement | null = null;
	private _baseHoverHideTimer: number | null = null;
	private _baseHoverSwitchTimer: number | null = null;
	private _persistDataTimer: number | null = null;
	private _internalState: InternalPluginState = { citationIndexCacheByScope: {} };

	get activeFilePath() {
		return this._activeFilePath;
	}

	openSearchPanel(scope?: string) {
		const active = this.app.workspace.getActiveFile();
		const cache = active ? this.app.metadataCache.getFileCache(active) : null;
		const resolved = scope || this.resolveScopeFromFrontmatter(cache?.frontmatter as Record<string, unknown> | undefined);
		new SearchPanelModal(this.app, this, resolved, this.settings.searchPanelMaxResults || 80).open();
	}

	async setActiveFilePath(path: string) {
		if (path !== this._activeFilePath) {
			this._activeFilePath = path;

			if (!path) {
				this.view?.setEmptyView();
				return;
			}

			const active = this.app.workspace.getActiveFile();
			const cache = active ? this.app.metadataCache.getFileCache(active) : null;
			const scope = this.resolveScopeFromFrontmatter(cache?.frontmatter as Record<string, unknown> | undefined);
			this.ensureCitationIndex(scope, false).catch(() => {
				/* noop */
			});
			await this.view?.renderReferences();
		}
	}

	resolveScopeFromFrontmatter(frontmatter: Record<string, unknown> | null | undefined): string {
		const bib = frontmatter?.[FrontMatterScopeProperty];
		if (typeof bib === 'string' && bib.trim().length > 0) {
			return bib.trim();
		}
		return (this.settings.defaultZoteroScope || 'My Library').trim();
	}

	getActiveScope(): string {
		const active = this.app.workspace.getActiveFile();
		const cache = active ? this.app.metadataCache.getFileCache(active) : null;
		return this.resolveScopeFromFrontmatter(cache?.frontmatter as Record<string, unknown> | undefined);
	}

	private defaultCitationIndexStatus(scope: string): CitationIndexStatus {
		return {
			scope,
			connection: 'unknown',
			rows: 0,
			source: 'none',
			loading: false,
			stale: false,
			lastRefreshedAt: null,
			cachedAt: null,
			errorText: '',
		};
	}

	private setCitationIndexStatus(scopePath: string, patch: Partial<CitationIndexStatus>) {
		const scope = scopePath.trim();
		if (!scope) return;
		const current = this._indexStatusByScope.get(scope) || this.defaultCitationIndexStatus(scope);
		const next: CitationIndexStatus = {
			...current,
			...patch,
			scope,
		};
		this._indexStatusByScope.set(scope, next);
		this.view?.refreshHeaderStatus();
	}

	getCitationIndexStatus(scopePath?: string): CitationIndexStatus {
		const scope = (scopePath || this.getActiveScope() || this.settings.defaultZoteroScope || 'My Library').trim();
		const current = this._indexStatusByScope.get(scope) || this.defaultCitationIndexStatus(scope);
		return { ...current };
	}

	getCitationIndexStatusDisplay(scopePath?: string, detectedMentions: number = 0): { label: string; tone: 'connected' | 'loading' | 'degraded' | 'offline' | 'neutral'; title: string } {
		const status = this.getCitationIndexStatus(scopePath);
		let label = '';
		let tone: 'connected' | 'loading' | 'degraded' | 'offline' | 'neutral' = 'neutral';

		if (status.loading) {
			label = 'Indexing…';
			tone = 'loading';
		} else if (status.connection === 'disconnected') {
			label = 'Offline';
			tone = 'offline';
		} else if (status.connection === 'degraded') {
			label = 'Degraded';
			tone = 'degraded';
		} else if (status.connection === 'connected') {
			label = 'Connected';
			tone = 'connected';
		} else if (status.rows > 0) {
			label = 'Connected';
			tone = 'connected';
		}

		const sourceLabel = ({
			'memory': 'memory cache',
			'disk': 'disk cache',
			'live-export': 'Zotero live export',
			'local-api': 'Zotero local API',
			'json-fallback': 'JSON fallback',
			'none': 'no index',
		} as Record<CitationIndexSource, string>)[status.source];
		const lines = [
			`Scope: ${status.scope}`,
			`Rows: ${status.rows}`,
			`Source: ${sourceLabel}`,
		];
		if (status.cachedAt) {
			lines.push(`Cached: ${new Date(status.cachedAt).toLocaleString()}`);
		}
		if (status.lastRefreshedAt) {
			lines.push(`Last refresh: ${new Date(status.lastRefreshedAt).toLocaleString()}`);
		}
		if (status.stale) {
			lines.push('Status: using cached or fallback data');
		}
		if (detectedMentions > 0) {
			lines.push(`Detected citekeys in view: ${detectedMentions}`);
		}
		if (status.errorText) {
			lines.push(status.errorText);
		}

		return {
			label,
			tone,
			title: lines.join('\n'),
		};
	}

	private normalizeInternalState(rawInternal: unknown): InternalPluginState {
		const state: InternalPluginState = { citationIndexCacheByScope: {} };
		if (!rawInternal || typeof rawInternal !== 'object') return state;
		const rawCache = (rawInternal as Record<string, unknown>).citationIndexCacheByScope;
		if (!rawCache || typeof rawCache !== 'object') return state;
		for (const [scope, value] of Object.entries(rawCache as Record<string, unknown>)) {
			if (!value || typeof value !== 'object') continue;
			const rowValue = (value as Record<string, unknown>).rows;
			const cachedAt = (value as Record<string, unknown>).cachedAt;
			const source = (value as Record<string, unknown>).source;
			if (!Array.isArray(rowValue)) continue;
			if (typeof cachedAt !== 'number' || !Number.isFinite(cachedAt)) continue;
			if (source !== 'live-export' && source !== 'local-api' && source !== 'json-fallback') continue;
			const rows = rowValue
				.filter((entry): entry is CitationIndexEntry => {
					if (!entry || typeof entry !== 'object') return false;
					const item = entry as Record<string, unknown>;
					return typeof item.id === 'string' && typeof item.title === 'string' && typeof item.meta === 'string' && typeof item.raw === 'object' && item.raw !== null;
				})
				.map((entry) => {
					const item = entry as Record<string, unknown>;
					return {
						id: item.id as string,
						title: item.title as string,
						meta: item.meta as string,
						raw: item.raw as Record<string, unknown>,
					};
				});
			if (rows.length === 0) continue;
			state.citationIndexCacheByScope[scope] = {
				rows,
				cachedAt,
				source,
			};
		}
		return state;
	}

	private buildStoredData(): ZotsidianStoredData {
		return {
			...this.settings,
			_internal: this._internalState,
		};
	}

	private schedulePersistPluginData() {
		if (this._persistDataTimer != null) {
			window.clearTimeout(this._persistDataTimer);
		}
		this._persistDataTimer = window.setTimeout(() => {
			this._persistDataTimer = null;
			void this.saveData(this.buildStoredData());
		}, 250);
	}

	private classifyConnectionState(error: unknown): CitationConnectionState {
		const message = error instanceof Error ? error.message : String(error || '');
		const normalized = message.toLowerCase();
		if (!normalized) return 'unknown';
		if (
			normalized.includes('econnrefused') ||
			normalized.includes('err_connection_refused') ||
			normalized.includes('unable to connect') ||
			normalized.includes('socket hang up') ||
			normalized.includes('local zotero api failed')
		) {
			return 'disconnected';
		}
		return 'degraded';
	}

	private describeIndexError(error: unknown): string {
		if (!error) return '';
		const message = error instanceof Error ? error.message : String(error);
		const normalized = message.toLowerCase();
		if (
			normalized.includes('econnrefused') ||
			normalized.includes('err_connection_refused') ||
			normalized.includes('unable to connect') ||
			normalized.includes('local zotero api failed')
		) {
			return 'Unable to reach Zotero. Check that Zotero is running and "Allow other applications on this computer to communicate with Zotero" is enabled.';
		}
		if (normalized.includes('unable to find zotero collection')) {
			return message;
		}
		return message;
	}

	private loadCitationIndexFromDisk(scopePath: string): CitationIndexEntry[] {
		const scope = scopePath.trim();
		if (!scope) return [];
		const cached = this._internalState.citationIndexCacheByScope[scope];
		if (!cached || !Array.isArray(cached.rows) || cached.rows.length === 0) return [];
		this._indexByScope.set(scope, cached.rows);
		this.setCitationIndexStatus(scope, {
			rows: cached.rows.length,
			source: 'disk',
			loading: false,
			stale: true,
			cachedAt: cached.cachedAt,
			lastRefreshedAt: null,
			errorText: '',
		});
		return cached.rows;
	}

	private persistCitationIndexCache(scopePath: string, entries: CitationIndexEntry[], source: Exclude<CitationIndexSource, 'memory' | 'disk' | 'none'>) {
		const scope = scopePath.trim();
		if (!scope) return;
		this._internalState.citationIndexCacheByScope[scope] = {
			rows: entries,
			cachedAt: Date.now(),
			source,
		};
		this.schedulePersistPluginData();
	}

	private getLeafFile(leaf: WorkspaceLeaf | null): TFile | null {
		if (!leaf) return null;
		const view = leaf.view as { file?: TFile | null };
		return view?.file instanceof TFile ? view.file : null;
	}

	private isBaseLeaf(leaf: WorkspaceLeaf | null): boolean {
		if (!leaf) return false;
		const file = this.getLeafFile(leaf);
		if (file?.extension === 'base' || file?.extension === 'canvas') return true;
		const view = leaf.view as { getViewType?: () => string; type?: string; containerEl?: HTMLElement };
		const type = typeof view?.getViewType === 'function' ? view.getViewType() : (typeof view?.type === 'string' ? view.type : '');
		if (type.toLowerCase().includes('base') || type.toLowerCase().includes('canvas')) return true;
		const container = view?.containerEl;
		return container instanceof HTMLElement && (
			container.matches('[data-type*="base" i], [data-type*="canvas" i]') ||
			!!container.querySelector('[class*="base" i], [data-type*="base" i], [class*="canvas" i], [data-type*="canvas" i]')
		);
	}

	private getBaseViewRoot(leaf: WorkspaceLeaf | null): HTMLElement | null {
		if (!this.isBaseLeaf(leaf)) return null;
		const view = leaf?.view as { containerEl?: HTMLElement } | undefined;
		const container = view?.containerEl;
		if (!(container instanceof HTMLElement)) return null;
		return (
			container.querySelector<HTMLElement>('.canvas-wrapper') ||
			container.querySelector<HTMLElement>('.view-content') ||
			container.querySelector<HTMLElement>('.workspace-leaf-content') ||
			container
		);
	}

	private extractVisibleBaseCitationsFromLeaf(leaf: WorkspaceLeaf | null): string[] {
		const root = this.getBaseViewRoot(leaf);
		if (!(root instanceof HTMLElement)) return [];
		const text = root.innerText || root.textContent || '';
		return citationsInText(text);
	}

	getVisibleCitationsFromActiveContext(activeFile: TFile | null): string[] | null {
		if (!(activeFile instanceof TFile) || (activeFile.extension !== 'base' && activeFile.extension !== 'canvas')) return null;
		const leaf = this.app.workspace.activeLeaf ?? this.app.workspace.getMostRecentLeaf();
		if (!this.isBaseLeaf(leaf)) return null;
		return this.extractVisibleBaseCitationsFromLeaf(leaf);
	}

	private clearBaseViewObserver() {
		if (this._baseViewObserver) {
			this._baseViewObserver.disconnect();
			this._baseViewObserver = null;
		}
		if (this._baseViewRefreshTimer != null) {
			window.clearTimeout(this._baseViewRefreshTimer);
			this._baseViewRefreshTimer = null;
		}
	}

	private clearBaseHoverSwitchTimer() {
		if (this._baseHoverSwitchTimer != null) {
			window.clearTimeout(this._baseHoverSwitchTimer);
			this._baseHoverSwitchTimer = null;
		}
	}

	private scheduleBaseViewRefresh() {
		if (this._baseViewRefreshTimer != null) {
			window.clearTimeout(this._baseViewRefreshTimer);
		}
		this._baseViewRefreshTimer = window.setTimeout(async () => {
			this._baseViewRefreshTimer = null;
			const leaf = this.app.workspace.activeLeaf ?? this.app.workspace.getMostRecentLeaf();
			const file = this.getLeafFile(leaf) ?? this.app.workspace.getActiveFile();
			if (!(file instanceof TFile) || (file.extension !== 'base' && file.extension !== 'canvas') || !this.isBaseLeaf(leaf)) return;
			await this.view?.refreshReferences();
			await this.view?.renderReferences();
		}, 140);
	}

	private hideBaseHoverCard() {
		this.clearBaseHoverSwitchTimer();
		if (this._baseHoverHideTimer != null) {
			window.clearTimeout(this._baseHoverHideTimer);
			this._baseHoverHideTimer = null;
		}
		if (this._baseHoverCardEl) {
			this._baseHoverCardEl.remove();
			this._baseHoverCardEl = null;
		}
		this._baseHoverTargetEl = null;
	}

	private scheduleHideBaseHoverCard() {
		this.clearBaseHoverSwitchTimer();
		if (this._baseHoverHideTimer != null) {
			window.clearTimeout(this._baseHoverHideTimer);
		}
		this._baseHoverHideTimer = window.setTimeout(() => {
			this.hideBaseHoverCard();
		}, 90);
	}

	private extractStandaloneCitationFromElement(element: HTMLElement): string | null {
		const text = (element.innerText || element.textContent || '').trim();
		if (!text || text.length > 140) return null;
		const mentions = citationsInText(text);
		if (mentions.length !== 1) return null;
		const citekey = mentions[0];
		const acceptable = new RegExp(`^(?:\\[@${citekey.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\]|@${citekey.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}|\\[\\[@${citekey.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\]\\])$`, 'i');
		return acceptable.test(text) ? citekey : null;
	}

	private findBaseHoverTarget(start: HTMLElement, root: HTMLElement): { element: HTMLElement; citekey: string } | null {
		let current: HTMLElement | null = start;
		while (current) {
			if (current === root.parentElement) break;
			if (current.classList.contains('zotsidian-base-hover-card')) return null;
			const citekey = this.extractStandaloneCitationFromElement(current);
			if (citekey) return { element: current, citekey };
			if (current === root) break;
			current = current.parentElement;
		}
		return null;
	}

	private positionBaseHoverCard(card: HTMLElement, target: HTMLElement) {
		const rect = target.getBoundingClientRect();
		const cardRect = card.getBoundingClientRect();
		const viewportWidth = window.innerWidth;
		const viewportHeight = window.innerHeight;
		const gap = 8;
		const fitsRight = rect.right + gap + cardRect.width <= viewportWidth - 12;
		const fitsLeft = rect.left - gap - cardRect.width >= 12;
		let left = rect.left;
		let top = rect.bottom + 2;
		if (fitsRight) {
			left = rect.right + gap;
			top = rect.top;
		} else if (fitsLeft) {
			left = rect.left - cardRect.width - gap;
			top = rect.top;
		} else {
			if (left + cardRect.width > viewportWidth - 12) {
				left = Math.max(12, viewportWidth - cardRect.width - 12);
			}
			if (top + cardRect.height > viewportHeight - 12) {
				top = Math.max(12, rect.top - cardRect.height - 2);
			}
		}
		if (top + cardRect.height > viewportHeight - 12) {
			top = Math.max(12, viewportHeight - cardRect.height - 12);
		}
		card.style.left = `${Math.round(left)}px`;
		card.style.top = `${Math.round(top)}px`;
	}

	private showBaseHoverCard(target: HTMLElement, citekey: string) {
		if (!this.settings.showCitationHoverCard) {
			this.hideBaseHoverCard();
			return;
		}
		this.clearBaseHoverSwitchTimer();
		if (this._baseHoverHideTimer != null) {
			window.clearTimeout(this._baseHoverHideTimer);
			this._baseHoverHideTimer = null;
		}
		if (this._baseHoverTargetEl === target && this._baseHoverCardEl?.isConnected) {
			this.positionBaseHoverCard(this._baseHoverCardEl, target);
			return;
		}
		this.hideBaseHoverCard();
		const card = createCitationHoverCardElement(this, citekey);
		card.classList.add('zotsidian-base-hover-card');
		card.addEventListener('mouseenter', () => {
			if (this._baseHoverHideTimer != null) {
				window.clearTimeout(this._baseHoverHideTimer);
				this._baseHoverHideTimer = null;
			}
		});
		card.addEventListener('mouseleave', () => {
			this.scheduleHideBaseHoverCard();
		});
		document.body.appendChild(card);
		this._baseHoverCardEl = card;
		this._baseHoverTargetEl = target;
		this.positionBaseHoverCard(card, target);
		window.requestAnimationFrame(() => {
			if (this._baseHoverCardEl === card && this._baseHoverTargetEl === target) {
				this.positionBaseHoverCard(card, target);
			}
		});
	}

	private scheduleSwitchBaseHoverCard(target: HTMLElement, citekey: string) {
		this.clearBaseHoverSwitchTimer();
		this._baseHoverSwitchTimer = window.setTimeout(() => {
			this._baseHoverSwitchTimer = null;
			this.showBaseHoverCard(target, citekey);
		}, 120);
	}

	private handleDocumentMouseOver(event: MouseEvent) {
		if (!this.settings.showCitationHoverCard) {
			this.hideBaseHoverCard();
			return;
		}
		const target = event.target;
		if (!(target instanceof HTMLElement)) return;
		if (this._baseHoverCardEl?.contains(target)) {
			if (this._baseHoverHideTimer != null) {
				window.clearTimeout(this._baseHoverHideTimer);
				this._baseHoverHideTimer = null;
			}
			this.clearBaseHoverSwitchTimer();
			return;
		}
		const leaf = this.app.workspace.activeLeaf ?? this.app.workspace.getMostRecentLeaf();
		const root = this.getBaseViewRoot(leaf);
		if (!(root instanceof HTMLElement)) {
			this.hideBaseHoverCard();
			return;
		}
		if (!root.contains(target)) return;
		const hoverTarget = this.findBaseHoverTarget(target, root);
		if (!hoverTarget) return;
		if (this._baseHoverTargetEl === hoverTarget.element && this._baseHoverCardEl?.isConnected) {
			if (this._baseHoverHideTimer != null) {
				window.clearTimeout(this._baseHoverHideTimer);
				this._baseHoverHideTimer = null;
			}
			this.clearBaseHoverSwitchTimer();
			return;
		}
		if (this._baseHoverCardEl?.isConnected && this._baseHoverTargetEl) {
			this.scheduleSwitchBaseHoverCard(hoverTarget.element, hoverTarget.citekey);
			return;
		}
		this.showBaseHoverCard(hoverTarget.element, hoverTarget.citekey);
	}

	private handleDocumentMouseOut(event: MouseEvent) {
		const target = event.target;
		if (!(target instanceof Node)) return;
		if (this._baseHoverTargetEl && this._baseHoverTargetEl.contains(target)) {
			const related = event.relatedTarget;
			if (
				related instanceof Node &&
				(
					this._baseHoverTargetEl.contains(related) ||
					this._baseHoverCardEl?.contains(related)
				)
			) {
				return;
			}
			this.scheduleHideBaseHoverCard();
		}
	}

	private syncActiveBaseViewSupport(leaf: WorkspaceLeaf | null) {
		this.clearBaseViewObserver();
		this.hideBaseHoverCard();
		const root = this.getBaseViewRoot(leaf);
		if (!(root instanceof HTMLElement)) return;
		this._baseViewObserver = new MutationObserver(() => {
			this.hideBaseHoverCard();
			this.scheduleBaseViewRefresh();
		});
		this._baseViewObserver.observe(root, {
			childList: true,
			subtree: true,
			characterData: true,
		});
	}

	private handleDocumentMouseDown(event: MouseEvent) {
		const target = event.target;
		if (!(target instanceof Node)) {
			this.hideBaseHoverCard();
			return;
		}
		if (
			(this._baseHoverCardEl && this._baseHoverCardEl.contains(target)) ||
			(this._baseHoverTargetEl && this._baseHoverTargetEl.contains(target))
		) {
			return;
		}
		this.hideBaseHoverCard();
	}

	private parseYear(raw: Record<string, unknown>): string {
		const issued = raw.issued as Record<string, unknown> | undefined;
		if (issued) {
			const dateParts = issued['date-parts'];
			if (Array.isArray(dateParts) && Array.isArray(dateParts[0]) && dateParts[0].length > 0) {
				const year = String((dateParts[0] as unknown[])[0] ?? '');
				if (year) return year;
			}
			const literal = issued.literal;
			if (typeof literal === 'string') {
				const m = literal.match(/(19|20)\d{2}/);
				if (m) return m[0];
			}
		}
		return '';
	}

	private parseYearNumber(raw?: Record<string, unknown>): number | null {
		if (!raw) return null;
		const direct = raw.year;
		if (typeof direct === 'number' && Number.isFinite(direct)) return direct;
		if (typeof direct === 'string') {
			const matched = direct.match(/(19|20)\d{2}/);
			if (matched) return Number(matched[0]);
		}
		const parsed = this.parseYear(raw);
		return parsed ? Number(parsed) : null;
	}

	private parseLeadAuthor(raw: Record<string, unknown>): string {
		const creators = Array.isArray(raw.creators) ? raw.creators : Array.isArray(raw.author) ? raw.author : [];
		if (creators.length > 0) {
			const first = creators[0] as Record<string, unknown>;
			if (typeof first.family === 'string' && first.family.length > 0) return first.family;
			if (typeof first.lastName === 'string' && first.lastName.length > 0) return first.lastName;
			if (typeof first.literal === 'string' && first.literal.length > 0) return first.literal;
			if (typeof first.name === 'string' && first.name.length > 0) return first.name;
		}
		return '';
	}

	private canonicalCitekey(key: string): string {
		return key.toLowerCase().replace(/[^a-z0-9]/g, '');
	}

	private resolveSourceNoteFile(citekey: string): TFile | null {
		const key = citekey.replace(/^@+/, '').trim();
		if (!key) return null;
		const folder = (this.settings.sourceNotesFolderPath || this._discourseNodesFolderPath || 'source').trim();
		const exactPath = normalizePath(`${folder}/@${key}.md`);
		const exact = this.app.vault.getAbstractFileByPath(exactPath);
		if (exact instanceof TFile) return exact;

		const canonical = this.canonicalCitekey(key);
		const prefix = `${normalizePath(folder)}/@`;
		for (const md of this.app.vault.getMarkdownFiles()) {
			if (!md.path.startsWith(prefix)) continue;
			const mdKey = md.basename.replace(/^@+/, '');
			if (this.canonicalCitekey(mdKey) === canonical) {
				return md;
			}
		}
		return null;
	}

	findSourceNoteFile(citekey: string): TFile | null {
		return this.resolveSourceNoteFile(citekey);
	}

	private getSourceFrontmatter(citekey: string): Record<string, unknown> | null {
		const file = this.resolveSourceNoteFile(citekey);
		if (!(file instanceof TFile)) return null;
		const cache = this.app.metadataCache.getFileCache(file);
		const fm = cache?.frontmatter as Record<string, unknown> | undefined;
		return fm ?? null;
	}

	private enrichRawWithSourceInfo(citekey: string, raw: Record<string, unknown>): Record<string, unknown> {
		const fm = this.getSourceFrontmatter(citekey);
		if (!fm) return raw;
		const enriched: Record<string, unknown> = { ...raw };
		const sourceItemKey = typeof fm['zotero-key'] === 'string' ? fm['zotero-key'] : '';
		const sourceZoteroUri = typeof fm['zotero'] === 'string' ? fm['zotero'] : '';
		let sourceUriItemKey = '';
		if (sourceZoteroUri) {
			const matched = sourceZoteroUri.match(/items\/([A-Z0-9]{8})/i);
			if (matched?.[1]) sourceUriItemKey = matched[1].toUpperCase();
		}
		if (!enriched.itemKey && sourceItemKey) enriched.itemKey = sourceItemKey;
		if (!enriched.itemKey && sourceUriItemKey) enriched.itemKey = sourceUriItemKey;
		if (!enriched.zoteroItemID && sourceZoteroUri) enriched.zoteroItemID = sourceZoteroUri;
		if (!enriched.zotero && sourceZoteroUri) enriched.zotero = sourceZoteroUri;
		if ((!enriched.id || typeof enriched.id !== 'string') && typeof fm.citekey === 'string') {
			enriched.id = fm.citekey;
		}
		if ((!enriched.title || typeof enriched.title !== 'string') && typeof fm.title === 'string') {
			enriched.title = fm.title;
		}
		if ((!enriched.DOI || typeof enriched.DOI !== 'string') && typeof fm.DOI === 'string') {
			enriched.DOI = fm.DOI;
		}
		if ((!enriched.year || typeof enriched.year !== 'string') && typeof fm.year === 'string') {
			enriched.year = fm.year;
		}
		if ((!enriched['container-title'] || typeof enriched['container-title'] !== 'string') && typeof fm.journal === 'string') {
			enriched['container-title'] = fm.journal;
		}
		if ((!enriched.creators || !Array.isArray(enriched.creators)) && Array.isArray(fm.authors)) {
			enriched.creators = fm.authors.map((author) => ({ literal: author }));
		}
		return enriched;
	}

	normalizeCitekeyForInsert(key: string): string {
		if (!this.settings.normalizeCitekeyOnInsert) return key;
		const cleaned = key.replace(/[^A-Za-z0-9_-]/g, '');
		return cleaned.length > 0 ? cleaned : key;
	}

	buildCitationInsertion(citekey: string, format: CitationInsertFormat = this.settings.citationInsertFormat): string {
		const normalized = this.normalizeCitekeyForInsert(citekey.replace(/^@+/, '').trim());
		if (!normalized) {
			return format === 'wikilink' ? '[[@]]' : (format === 'plain' ? '@' : '[@]');
		}
		if (format === 'plain') return `@${normalized}`;
		if (format === 'wikilink') return `[[@${normalized}]]`;
		return `[@${normalized}]`;
	}

	private normalizeTitleKey(value: unknown): string {
		if (typeof value !== 'string') return '';
		return value
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, ' ')
			.trim()
			.replace(/\s+/g, ' ');
	}

	private compactTitleKey(value: unknown): string {
		return this.normalizeTitleKey(value).replace(/\s+/g, '');
	}

	private semanticScholarUrlFor(value: { doi?: string; title?: string; paperId?: string; url?: string }): string {
		if (typeof value.url === 'string' && value.url.includes('semanticscholar.org')) return value.url.trim();
		if (typeof value.paperId === 'string' && value.paperId.trim() && !/^W\d+$/i.test(value.paperId.trim())) {
			return `https://www.semanticscholar.org/paper/${encodeURIComponent(value.paperId.trim())}`;
		}
		if (typeof value.doi === 'string' && value.doi.trim()) {
			return `https://www.semanticscholar.org/search?q=${encodeURIComponent(value.doi.trim())}`;
		}
		if (typeof value.title === 'string' && value.title.trim()) {
			return `https://www.semanticscholar.org/search?q=${encodeURIComponent(value.title.trim())}`;
		}
		return '';
	}

	private zoteroUriForRaw(raw?: Record<string, unknown>): string {
		if (!raw) return '';
		const explicit = typeof raw.zotero === 'string' ? raw.zotero.trim() : '';
		if (explicit.startsWith('zotero://')) return explicit;
		const itemKey = this.parseCitationItemKey(raw);
		if (itemKey) return `zotero://select/library/items/${itemKey}`;
		const zoteroItemID = typeof raw.zoteroItemID === 'string' ? raw.zoteroItemID.trim() : '';
		if (zoteroItemID.startsWith('zotero://')) return zoteroItemID;
		if (zoteroItemID.includes('/items/')) return zoteroItemID;
		return '';
	}

	private googleScholarUrlFor(value: { doi?: string; title?: string }): string {
		const doi = typeof value.doi === 'string' ? value.doi.trim() : '';
		if (doi) return `https://scholar.google.com/scholar?q=${encodeURIComponent(doi)}`;
		const title = typeof value.title === 'string' ? value.title.trim() : '';
		return title ? `https://scholar.google.com/scholar?q=${encodeURIComponent(title)}` : '';
	}

	private connectedPapersUrlFor(value: { doi?: string; title?: string }): string {
		const doi = typeof value.doi === 'string' ? value.doi.trim() : '';
		if (doi) return `https://www.connectedpapers.com/api/redirect/doi/${encodeURIComponent(doi)}`;
		const title = typeof value.title === 'string' ? value.title.trim() : '';
		return title ? `https://www.connectedpapers.com/search?q=${encodeURIComponent(title)}` : '';
	}

	private toCitationEntry(item: Record<string, unknown>): CitationIndexEntry | null {
		const id = typeof item.id === 'string' ? item.id.trim() : '';
		if (!id) return null;
		if (id.startsWith('http://') || id.startsWith('https://')) return null;
		const title = typeof item.title === 'string' ? item.title : '';
		const author = this.parseLeadAuthor(item);
		const year = this.parseYear(item);
		const meta = [author, year ? `(${year})` : ''].filter(Boolean).join(' ');
		return { id, title, meta, raw: item };
	}

	private async loadLocalLibraryIndex(scopePath: string): Promise<Record<string, unknown>[]> {
		const libraryName = scopePath.split('/').map((x) => x.trim()).filter(Boolean)[0] || '';
		const candidates: string[] = [];
		const configured = (this.settings.localLibraryJsonPath || '').trim();
		if (configured) candidates.push(configured);
		if (libraryName) candidates.push(`${libraryName}.json`);
		const seen = new Set<string>();

		for (const candidate of candidates) {
			const path = normalizePath(candidate);
			if (seen.has(path)) continue;
			seen.add(path);
			try {
				const exists = await this.app.vault.adapter.exists(path);
				if (!exists) continue;
				const content = await this.app.vault.adapter.read(path);
				const parsed = JSON.parse(content) as unknown;
				let rows: unknown[] = [];
				if (Array.isArray(parsed)) {
					rows = parsed;
				} else if (parsed && typeof parsed === 'object') {
					const items = (parsed as Record<string, unknown>).items;
					if (Array.isArray(items)) rows = items;
				}
				if (rows.length > 0) {
					return normalizeExportItems(rows);
				}
			} catch (_err) {
				// Try next candidate.
			}
		}

		return [];
	}

	private searchEntries(entries: CitationIndexEntry[], query: string, limit: number): CitationIndexEntry[] {
		const q = query.trim().toLowerCase();
		if (!q) return [];
		const tokens = q.split(/\s+/).filter(Boolean);
		const qCanonical = this.canonicalCitekey(q);
		const scored: { entry: CitationIndexEntry; score: number }[] = [];

		for (const entry of entries) {
			const id = entry.id.toLowerCase();
			const title = (entry.title || '').toLowerCase();
			const meta = (entry.meta || '').toLowerCase();
			const idCanonical = this.canonicalCitekey(id);
			const hay = `${id} ${title} ${meta} ${idCanonical}`;
			if (!tokens.every((t) => hay.includes(t))) continue;

			let score = 0;
			if (id.startsWith(q)) score += 100;
			else if (id.includes(q)) score += 80;
			if (qCanonical && idCanonical.startsWith(qCanonical)) score += 75;
			else if (qCanonical && idCanonical.includes(qCanonical)) score += 55;
			if (title.includes(q)) score += 60;
			if (meta.includes(q)) score += 40;
			score -= id.indexOf(q) >= 0 ? id.indexOf(q) : 0;
			scored.push({ entry, score });
		}

		scored.sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id));
		return scored.slice(0, limit).map((x) => x.entry);
	}

	private async refreshCitationIndexFromSources(scopePath: string): Promise<CitationIndexEntry[]> {
		const scope = scopePath.trim();
		const existingRows = this._indexByScope.get(scope) || [];
		const currentStatus = this._indexStatusByScope.get(scope) || this.defaultCitationIndexStatus(scope);
		this.setCitationIndexStatus(scope, {
			connection: existingRows.length > 0 ? currentStatus.connection : 'connecting',
			rows: existingRows.length,
			source: currentStatus.source,
			loading: true,
			stale: currentStatus.stale,
			errorText: '',
		});

		let rawRows: unknown[] = [];
		let apiError: unknown = null;
		let source: Exclude<CitationIndexSource, 'memory' | 'disk' | 'none'> | 'none' = 'none';

		try {
			const raw = await exportCollectionPath(scope, 'json') as unknown[];
			rawRows = Array.isArray(raw) ? raw : [];
			if (rawRows.length > 0) {
				source = 'live-export';
			}
		} catch (err) {
			apiError = err;
		}

		if (rawRows.length === 0 && scope.includes('/')) {
			const libraryOnlyScope = scope.split('/')[0]?.trim() || '';
			if (libraryOnlyScope.length > 0 && libraryOnlyScope !== scope) {
				try {
					const fallbackRaw = await exportCollectionPath(libraryOnlyScope, 'json') as unknown[];
					rawRows = Array.isArray(fallbackRaw) ? fallbackRaw : [];
					if (rawRows.length > 0) {
						source = 'live-export';
					}
				} catch (err) {
					if (!apiError) apiError = err;
				}
			}
		}

		if (rawRows.length === 0) {
			try {
				rawRows = await localApiLibraryIndex(scope);
				if (rawRows.length > 0) {
					source = 'local-api';
				}
			} catch (err) {
				if (!apiError) apiError = err;
			}
		}

		if (rawRows.length === 0) {
			rawRows = await this.loadLocalLibraryIndex(scope);
			if (rawRows.length > 0) {
				source = 'json-fallback';
			}
		}

		if (rawRows.length === 0 && apiError) {
			console.warn(`Zotsidian: no index rows loaded for scope "${scope}".`, apiError);
		}

		const normalized = normalizeExportItems(rawRows);
		const dedup = new Map<string, CitationIndexEntry>();
		for (const row of normalized) {
			const entry = this.toCitationEntry(row as Record<string, unknown>);
			if (entry && !dedup.has(entry.id)) dedup.set(entry.id, entry);
		}
		const entries = Array.from(dedup.values());
		const now = Date.now();

		if (entries.length > 0) {
			this._indexByScope.set(scope, entries);
			if (source !== 'none') {
				this.persistCitationIndexCache(scope, entries, source);
			}
			this.setCitationIndexStatus(scope, {
				connection: source === 'json-fallback'
					? (apiError ? this.classifyConnectionState(apiError) : 'degraded')
					: 'connected',
				rows: entries.length,
				source,
				loading: false,
				stale: source === 'json-fallback',
				lastRefreshedAt: now,
				cachedAt: now,
				errorText: source === 'json-fallback' ? this.describeIndexError(apiError) : '',
			});
			return entries;
		}

		if (existingRows.length > 0) {
			this.setCitationIndexStatus(scope, {
				connection: apiError ? this.classifyConnectionState(apiError) : 'degraded',
				rows: existingRows.length,
				source: currentStatus.source,
				loading: false,
				stale: true,
				errorText: this.describeIndexError(apiError),
			});
			return existingRows;
		}

		this.setCitationIndexStatus(scope, {
			connection: apiError ? this.classifyConnectionState(apiError) : 'degraded',
			rows: 0,
			source: 'none',
			loading: false,
			stale: false,
			lastRefreshedAt: null,
			cachedAt: null,
			errorText: apiError ? this.describeIndexError(apiError) : 'No index rows loaded for this scope.',
		});
		return [];
	}

	private async triggerCitationIndexRefresh(scopePath: string): Promise<CitationIndexEntry[]> {
		const scope = scopePath.trim();
		if (!scope) return [];
		if (this._indexPromiseByScope.has(scope)) {
			const pending = this._indexPromiseByScope.get(scope);
			if (pending) return await pending;
		}
		const promise = this.refreshCitationIndexFromSources(scope).finally(() => {
			this._indexPromiseByScope.delete(scope);
			this.view?.refreshHeaderStatus();
			if (this.getActiveScope() === scope) {
				void this.view?.refreshReferences().then(async () => {
					await this.view?.renderReferences();
				});
			}
		});
		this._indexPromiseByScope.set(scope, promise);
		return await promise;
	}

	async ensureCitationIndex(scopePath: string, force: boolean = false): Promise<CitationIndexEntry[]> {
		const scope = scopePath.trim();
		if (!scope) return [];

		if (!force && this._indexByScope.has(scope)) {
			const entries = this._indexByScope.get(scope) || [];
			const currentStatus = this._indexStatusByScope.get(scope) || this.defaultCitationIndexStatus(scope);
			this.setCitationIndexStatus(scope, {
				rows: entries.length,
				source: currentStatus.source === 'none' ? 'memory' : currentStatus.source,
			});
			return entries;
		}

		if (!force) {
			const diskRows = this.loadCitationIndexFromDisk(scope);
			if (diskRows.length > 0) {
				this.setCitationIndexStatus(scope, {
					connection: 'connecting',
					rows: diskRows.length,
					source: 'disk',
					loading: true,
					stale: true,
					errorText: '',
				});
				void this.triggerCitationIndexRefresh(scope);
				return diskRows;
			}
		}

		return await this.triggerCitationIndexRefresh(scope);
	}

	async searchCitationIndex(scopePath: string, query: string, limit: number = 40): Promise<CitationIndexEntry[]> {
		const scope = scopePath.trim();
		const q = query.trim().toLowerCase();
		if (!scope || !q) return [];

		let entries: CitationIndexEntry[] = [];
		try {
			entries = await this.ensureCitationIndex(scope, false);
		} catch (_err) {
			entries = [];
		}
		const cachedMatches = this.searchEntries(entries, q, limit);
		if (cachedMatches.length > 0) {
			return cachedMatches;
		}

		try {
			const liveRows = await libraryCitekeysTitles(scope, query, Math.max(40, limit * 2)) as Array<{
				id?: string;
				title?: string;
				meta?: string;
				itemKey?: string;
				zoteroItemID?: string;
			}>;
			if (Array.isArray(liveRows) && liveRows.length > 0) {
				return liveRows
					.filter((row): row is { id: string; title?: string; meta?: string; itemKey?: string; zoteroItemID?: string } => typeof row.id === 'string' && row.id.length > 0)
					.slice(0, limit)
					.map((row) => ({
						id: row.id,
						title: row.title || '',
						meta: row.meta || '',
						raw: {
							id: row.id,
							title: row.title || '',
							itemKey: row.itemKey,
							zoteroItemID: row.zoteroItemID,
						},
					}));
			}
		} catch (_err) {
			// Keep cached result path as the fast default.
		}

		return cachedMatches;
	}

	async getCitationMapFor(scopePath: string, citekeys: string[]): Promise<Map<string, Record<string, unknown>>> {
		const result = new Map<string, Record<string, unknown>>();
		if (!citekeys.length) return result;

		let entries: CitationIndexEntry[] = [];
		try {
			entries = await this.ensureCitationIndex(scopePath, false);
		} catch (_err) {
			entries = [];
		}

		if (entries.length > 0) {
			const byId = new Map(entries.map((entry) => [entry.id, entry]));
			const byCanonical = new Map<string, CitationIndexEntry>();
			for (const entry of entries) {
				const canonical = this.canonicalCitekey(entry.id);
				if (!byCanonical.has(canonical)) {
					byCanonical.set(canonical, entry);
				}
			}
			for (const cite of citekeys) {
				const direct = byId.get(cite);
				if (direct) {
					result.set(cite, this.enrichRawWithSourceInfo(cite, direct.raw));
					continue;
				}
				const alias = byCanonical.get(this.canonicalCitekey(cite));
				if (alias) {
					result.set(cite, this.enrichRawWithSourceInfo(cite, alias.raw));
				}
			}
		}

		const unresolvedForLive = citekeys.filter((c) => !result.has(c) || !this.hasRoutingData(result.get(c)));
		if (unresolvedForLive.length > 0) {
			try {
			const located = await locateCollection(scopePath);
				const live = await resolveCitekeysToItems(unresolvedForLive, located.libraryId);
			for (const [key, raw] of live.entries()) {
				result.set(key, this.enrichRawWithSourceInfo(key, raw as Record<string, unknown>));
			}
			} catch (_err) {
			// fall back to index path below
			}
		}

		const missingAfterLive = citekeys.filter((c) => !result.has(c) || !this.hasRoutingData(result.get(c)));
		if (missingAfterLive.length > 0) {
			try {
				const localApiMap = await resolveCitekeysToItemsViaLocalApi(missingAfterLive, scopePath);
				for (const [key, raw] of localApiMap.entries()) {
					result.set(key, this.enrichRawWithSourceInfo(key, raw as Record<string, unknown>));
				}
			} catch (_err) {
				// continue to local file index fallback
			}
		}

		const missing = citekeys.filter((c) => !result.has(c));
		if (missing.length === 0) return result;

		const byId = new Map(entries.map((e) => [e.id, e]));
		const byCanonical = new Map<string, CitationIndexEntry>();
		for (const entry of entries) {
			const canon = this.canonicalCitekey(entry.id);
			if (!byCanonical.has(canon)) byCanonical.set(canon, entry);
		}
		for (const c of missing) {
			const found = byId.get(c);
			if (found) {
				result.set(c, this.enrichRawWithSourceInfo(c, found.raw));
				continue;
			}
			const alias = byCanonical.get(this.canonicalCitekey(c));
			if (alias) result.set(c, this.enrichRawWithSourceInfo(c, alias.raw));
		}
		return result;
	}

	private matchSemanticPaperToLibraryEntry(
		paper: SemanticRelatedPaper,
		byDoi: Map<string, CitationIndexEntry>,
		byTitle: Map<string, CitationIndexEntry>,
		entries: CitationIndexEntry[]
	): CitationIndexEntry | null {
		const doiKey = normalizeDoi(paper.doi);
		if (doiKey && byDoi.has(doiKey)) {
			return byDoi.get(doiKey) || null;
		}
		const titleKey = this.normalizeTitleKey(paper.title);
		if (titleKey && byTitle.has(titleKey)) {
			return byTitle.get(titleKey) || null;
		}
		const compactPaperTitle = this.compactTitleKey(paper.title);
		if (!compactPaperTitle) return null;
		for (const entry of entries) {
			const compactEntryTitle = this.compactTitleKey(entry.title);
			if (!compactEntryTitle) continue;
			const entryYear = this.parseYearNumber(entry.raw);
			if (paper.year != null && entryYear != null && Math.abs(entryYear - paper.year) > 2) {
				continue;
			}
			if (compactEntryTitle === compactPaperTitle) return entry;
			const shorter = Math.min(compactEntryTitle.length, compactPaperTitle.length);
			if (shorter >= 24 && (compactEntryTitle.includes(compactPaperTitle) || compactPaperTitle.includes(compactEntryTitle))) {
				return entry;
			}
		}
		return null;
	}

	async getSourceRelatedData(scopePath: string, citekey: string, raw?: Record<string, unknown>): Promise<SourceRelatedData | null> {
		const scope = scopePath.trim() || this.settings.defaultZoteroScope || 'My Library';
		let title = typeof raw?.title === 'string' ? raw.title.trim() : '';
		let doi = normalizeDoi(raw?.DOI);
		let year = this.parseYearNumber(raw);
		let entries: CitationIndexEntry[] = [];
		try {
			entries = await this.ensureCitationIndex(scope, false);
		} catch (_err) {
			entries = [];
		}

		const currentEntry = entries.find((entry) => entry.id === citekey)
			|| entries.find((entry) => this.canonicalCitekey(entry.id) === this.canonicalCitekey(citekey))
			|| null;
		const currentRaw = currentEntry?.raw as Record<string, unknown> | undefined;
		if (!title) {
			title = currentEntry?.title || (typeof currentRaw?.title === 'string' ? currentRaw.title : citekey);
		}
		if (!doi) {
			doi = normalizeDoi(currentRaw?.DOI);
		}
		if (year == null) {
			year = this.parseYearNumber(currentRaw);
		}

		const cacheKey = doi
			? `doi:${doi}`
			: `title:${this.normalizeTitleKey(title)}:${year == null ? '' : String(year)}`;
		const cached = this._relatedDataCache.get(cacheKey);
		if (cached) {
			return await cached;
		}

		const pending = (async () => {
			if (!doi && !title) {
				return {
					doi: '',
					title: citekey,
					referenceCount: 0,
					citationCount: 0,
					references: [],
					citations: [],
					relatedLibraryItems: [],
					connectedPapersUrl: '',
					semanticScholarUrl: '',
					googleScholarUrl: '',
					lookupMode: 'unavailable' as const,
					provider: 'none' as const,
					note: 'No DOI or title is available for related-paper lookup.',
				};
			}

			let semantic;
			try {
				semantic = await fetchSourceRelatedPapers({ doi, title, year }, this.settings.relatedPapersProvider);
			} catch (error) {
				const resolvedTitle = title || citekey;
				return {
					doi: doi || '',
					title: resolvedTitle,
					referenceCount: 0,
					citationCount: 0,
					references: [],
					citations: [],
					relatedLibraryItems: [],
					connectedPapersUrl: this.connectedPapersUrlFor({ doi, title: resolvedTitle }),
					semanticScholarUrl: this.semanticScholarUrlFor({ doi, title: resolvedTitle }),
					googleScholarUrl: this.googleScholarUrlFor({ doi, title: resolvedTitle }),
					lookupMode: doi ? 'doi' as const : 'unavailable' as const,
					provider: 'none' as const,
					note: error instanceof Error ? error.message : String(error),
				};
			}

			const byDoi = new Map<string, CitationIndexEntry>();
			const byTitle = new Map<string, CitationIndexEntry>();
			for (const entry of entries) {
				const entryDoi = normalizeDoi((entry.raw as Record<string, unknown>).DOI);
				if (entryDoi && !byDoi.has(entryDoi)) {
					byDoi.set(entryDoi, entry);
				}
				const entryTitle = this.normalizeTitleKey(entry.title);
				if (entryTitle && !byTitle.has(entryTitle)) {
					byTitle.set(entryTitle, entry);
				}
			}

			const mapSemanticEntry = (paper: SemanticRelatedPaper): SourceRelatedEntry => {
				const local = this.matchSemanticPaperToLibraryEntry(paper, byDoi, byTitle, entries);
				return {
					relation: paper.relation,
					title: paper.title,
					venue: paper.venue,
					year: paper.year,
					doi: paper.doi,
					url: this.semanticScholarUrlFor({ doi: paper.doi, title: paper.title, paperId: paper.paperId, url: paper.url }),
					authors: paper.authors,
					localMatch: local ? {
						citekey: local.id,
						title: local.title,
						meta: local.meta,
						raw: local.raw,
						sourceNotePath: this.findSourceNoteFile(local.id)?.path ?? null,
					} : null,
				};
			};

			const references = semantic.references.map(mapSemanticEntry);
			const citations = semantic.citations.map(mapSemanticEntry);
			const relatedMap = new Map<string, SourceRelatedLibraryItem>();
			for (const entry of [...references, ...citations]) {
				const match = entry.localMatch;
				if (!match) continue;
				const existing = relatedMap.get(match.citekey);
				if (!existing) {
					relatedMap.set(match.citekey, {
						citekey: match.citekey,
						title: match.title,
						meta: match.meta,
						sourceNotePath: match.sourceNotePath,
						raw: match.raw,
						relations: [entry.relation],
					});
					continue;
				}
				if (!existing.relations.includes(entry.relation)) {
					existing.relations.push(entry.relation);
				}
			}

			const noteParts: string[] = [];
			if (semantic.lookupMode === 'title') {
				noteParts.push(`Resolved via ${semantic.provider === 'openalex' ? 'OpenAlex' : 'Semantic Scholar'} title search because no DOI was available.`);
			} else if (semantic.provider === 'openalex' && this.settings.relatedPapersProvider === 'auto') {
				noteParts.push('Semantic Scholar was unavailable or incomplete, so OpenAlex was used as a fallback.');
			}
			if (relatedMap.size === 0 && (semantic.references.length > 0 || semantic.citations.length > 0)) {
				noteParts.push('No local library matches were found for these references/citations.');
			}

			return {
				doi: semantic.doi,
				title: semantic.title || title,
				referenceCount: semantic.referenceCount,
				citationCount: semantic.citationCount,
				references,
				citations,
				relatedLibraryItems: Array.from(relatedMap.values()).sort((a, b) => a.citekey.localeCompare(b.citekey)),
				connectedPapersUrl: this.connectedPapersUrlFor({ doi: semantic.doi, title: semantic.title || title }),
				semanticScholarUrl: this.semanticScholarUrlFor({ doi: semantic.doi, title: semantic.title || title, paperId: semantic.paperId, url: semantic.url }),
				googleScholarUrl: this.googleScholarUrlFor({ doi: semantic.doi, title: semantic.title || title }),
				lookupMode: semantic.lookupMode,
				provider: semantic.provider,
				note: noteParts.join(' '),
			};
		})();

		this._relatedDataCache.set(cacheKey, pending);
		try {
			return await pending;
		} catch (error) {
			this._relatedDataCache.delete(cacheKey);
			throw error;
		}
	}

	private parseCitationAuthors(raw: Record<string, unknown>): string[] {
		const creators = Array.isArray(raw.creators) ? raw.creators : Array.isArray(raw.author) ? raw.author : [];
		return creators
			.map((creator) => {
				const c = creator as Record<string, unknown>;
				if (typeof c.family === 'string' && c.family.length > 0) return c.family;
				if (typeof c.lastName === 'string' && c.lastName.length > 0) return c.lastName;
				if (typeof c.literal === 'string' && c.literal.length > 0) return c.literal;
				if (typeof c.name === 'string' && c.name.length > 0) return c.name;
				return '';
			})
			.filter((x) => x.length > 0);
	}

	private parseCitationItemKey(raw: Record<string, unknown>): string {
		const itemKey = raw.itemKey;
		if (typeof itemKey === 'string' && /^[A-Z0-9]{8}$/i.test(itemKey)) return itemKey.toUpperCase();
		const sourceItemKey = raw['zotero-key'];
		if (typeof sourceItemKey === 'string' && /^[A-Z0-9]{8}$/i.test(sourceItemKey)) return sourceItemKey.toUpperCase();
		const zoteroId = raw.id;
		if (typeof zoteroId === 'string') {
			const matched = zoteroId.match(/items\/([A-Z0-9]{8})/);
			if (matched?.[1]) return matched[1].toUpperCase();
		}
		const zoteroItemID = raw.zoteroItemID;
		if (typeof zoteroItemID === 'string') {
			const matched = zoteroItemID.match(/items\/([A-Z0-9]{8})/);
			if (matched?.[1]) return matched[1].toUpperCase();
		}
		const zotero = raw.zotero;
		if (typeof zotero === 'string') {
			const matched = zotero.match(/items\/([A-Z0-9]{8})/);
			if (matched?.[1]) return matched[1].toUpperCase();
		}
		return '';
	}

	private hasRoutingData(raw?: Record<string, unknown>): boolean {
		if (!raw) return false;
		if (typeof raw.itemKey === 'string' && /^[A-Z0-9]{8}$/i.test(raw.itemKey)) return true;
		if (typeof raw['zotero-key'] === 'string' && /^[A-Z0-9]{8}$/i.test(raw['zotero-key'] as string)) return true;
		if (typeof raw.zoteroItemID === 'string' && raw.zoteroItemID.includes('/items/')) return true;
		if (typeof raw.zotero === 'string' && raw.zotero.includes('/items/')) return true;
		if (typeof raw.id === 'string' && raw.id.includes('/items/')) return true;
		return false;
	}

	private citationFrontmatterPatch(citekey: string, title: string, raw?: Record<string, unknown>): Record<string, unknown> {
		const patch: Record<string, unknown> = {
			citekey,
		};
		if (title) patch.title = title;
		if (!raw) return patch;

		const parsedYear = this.parseYear(raw);
		const parsedAuthors = this.parseCitationAuthors(raw);
		const container = typeof raw['container-title-short'] === 'string' && raw['container-title-short']
			? raw['container-title-short']
			: (typeof raw['container-title'] === 'string' ? raw['container-title'] : '');
		const itemType = typeof raw.type === 'string' ? raw.type : (typeof raw.itemType === 'string' ? raw.itemType : '');
		const doi = typeof raw.DOI === 'string' ? raw.DOI : '';
		const abstractText = typeof raw.abstract === 'string' ? raw.abstract : (typeof raw.abstractNote === 'string' ? raw.abstractNote : '');
		const itemKey = this.parseCitationItemKey(raw);
		const existingZotero = typeof raw.zotero === 'string' ? raw.zotero : '';
		const zoteroItemID = typeof raw.zoteroItemID === 'string' ? raw.zoteroItemID : '';
		const zoteroLink = existingZotero
			? existingZotero
			: (typeof raw.id === 'string' && raw.id.startsWith('http')
			? raw.id
			: (zoteroItemID ? zoteroItemID : (itemKey ? `zotero://select/library/items/${itemKey}` : '')));

		if (itemKey) patch['zotero-key'] = itemKey;
		if (parsedYear) patch.year = parsedYear;
		if (parsedAuthors.length) patch.authors = parsedAuthors;
		if (container) patch.journal = container;
		if (itemType) patch.itemType = itemType;
		if (doi) patch.DOI = doi;
		if (abstractText) patch.abstract = abstractText;
		if (zoteroLink) patch.zotero = zoteroLink;
		return patch;
	}

	async ensureSourcePageForCitekey(citekey: string, title: string = '', raw?: Record<string, unknown>): Promise<void> {
		if (!this.settings.autoCreateSourceOnCitationSelect) return;
		await this.materializeSourcePage(citekey, title, raw);
	}

	private async materializeSourcePage(citekey: string, title: string = '', raw?: Record<string, unknown>): Promise<TFile | null> {
		const key = citekey.replace(/^@+/, '').trim();
		if (!key) return null;
		let citationRaw = raw;
		if (!this.hasRoutingData(citationRaw)) {
			const active = this.app.workspace.getActiveFile();
			const cache = active ? this.app.metadataCache.getFileCache(active) : null;
			const scope = this.resolveScopeFromFrontmatter(cache?.frontmatter as Record<string, unknown> | undefined);
			const lookup = await this.getCitationMapFor(scope, [key]);
			citationRaw = lookup.get(key) || citationRaw;
		}
		const sourceFolder = (this.settings.sourceNotesFolderPath || this._discourseNodesFolderPath || 'source').trim();
		await this.ensureFolderExists(sourceFolder);
		const path = normalizePath(`${sourceFolder}/@${key}.md`);

		let file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) {
			const initial = `---\n---\n\n# @${key}\n`;
			file = await this.app.vault.create(path, initial);
		}
		if (file instanceof TFile) {
			await this.applySourceFrontmatter(file, key, title, citationRaw);
			this.invalidateHoverCacheForCitekey(key);
			return file;
		}
		return null;
	}

	async openOrCreateSourcePage(citekey: string, title: string = '', raw?: Record<string, unknown>): Promise<void> {
		const file = await this.materializeSourcePage(citekey, title, raw);
		if (!file) return;
		const leaf = this.app.workspace.getLeaf(false);
		await leaf.openFile(file);
	}

	async getCitationHoverData(scopePath: string, citekey: string): Promise<CitationHoverData | null> {
		const scope = scopePath.trim() || this.settings.defaultZoteroScope || 'My Library';
		const normalizedCitekey = citekey.replace(/^@+/, '').trim();
		if (!normalizedCitekey) return null;

		const cacheKey = `${scope}::${this.canonicalCitekey(normalizedCitekey)}`;
		const cached = this._hoverDataCache.get(cacheKey);
		if (cached) {
			return await cached;
		}

		const pending = (async () => {
			const sourceFile = this.findSourceNoteFile(normalizedCitekey);
			let raw = (await this.getCitationMapFor(scope, [normalizedCitekey])).get(normalizedCitekey);
			if (!raw) {
				const entries = await this.ensureCitationIndex(scope, false).catch(() => []);
				const matched = entries.find((entry) => this.canonicalCitekey(entry.id) === this.canonicalCitekey(normalizedCitekey));
				raw = matched?.raw;
			}
			if (!raw && sourceFile) {
				raw = this.enrichRawWithSourceInfo(normalizedCitekey, {});
			}

			const title = typeof raw?.title === 'string' && raw.title.trim().length > 0
				? raw.title.trim()
				: sourceFile?.basename.replace(/^@+/, '') || normalizedCitekey;
			const authors = raw ? this.parseCitationAuthors(raw) : [];
			const journal = raw
				? (typeof raw['container-title-short'] === 'string' && raw['container-title-short']
					? raw['container-title-short']
					: (typeof raw['container-title'] === 'string'
						? raw['container-title']
						: (typeof raw.journal === 'string' ? raw.journal : '')))
				: '';
			const year = raw ? (this.parseYear(raw) || (typeof raw.year === 'string' ? raw.year : '')) : '';
			const doi = raw && typeof raw.DOI === 'string' ? raw.DOI.trim() : '';
			const sourceNotePath = sourceFile?.path ?? null;

			const hint: AttachmentLookupHint | undefined = raw ? {
				itemKey: typeof raw.itemKey === 'string' ? raw.itemKey : (typeof raw['zotero-key'] === 'string' ? raw['zotero-key'] : undefined),
				zoteroItemID: typeof raw.zoteroItemID === 'string' ? raw.zoteroItemID : undefined,
				zotero: typeof raw.zotero === 'string' ? raw.zotero : undefined,
				citekey: typeof raw.id === 'string' ? raw.id : normalizedCitekey,
				doi: typeof raw.DOI === 'string' ? raw.DOI : undefined,
				title: typeof raw.title === 'string' ? raw.title : undefined,
			} : undefined;

			let attachmentRows: Array<{ label: string; open: string }> = [];
				try {
					const rows = await attachments(normalizedCitekey, scope.split('/')[0] || scope, hint);
					attachmentRows = (Array.isArray(rows) ? rows : [])
						.filter((row) => !!row && typeof row === 'object' && typeof (row as { open?: unknown }).open === 'string')
						.map((row) => {
							const item = row as { label?: string; open: string };
							return {
								label: typeof item.label === 'string' && item.label.trim().length > 0 ? item.label.trim() : 'Attachment',
								open: item.open,
							};
						});
				} catch (_err) {
					attachmentRows = [];
				}

			const pdfRow = attachmentRows.find((row) => row.open.startsWith('zotero://open-pdf/')) || null;
			const zoteroUri = this.zoteroUriForRaw(raw) || attachmentRows.find((row) => row.open.startsWith('zotero://select/'))?.open || null;
			const inLibrary = !!raw && (this.hasRoutingData(raw) || attachmentRows.length > 0);

			if (!inLibrary && !sourceNotePath && !title) {
				return null;
			}

			return {
				citekey: normalizedCitekey,
				title,
				authors,
				journal,
				year,
				doi,
				sourceNotePath,
				zoteroUri,
				pdfUri: pdfRow?.open || null,
				attachments: attachmentRows,
				inLibrary,
			};
		})();

		this._hoverDataCache.set(cacheKey, pending);
		try {
			return await pending;
		} catch (error) {
			this._hoverDataCache.delete(cacheKey);
			throw error;
		}
	}

	private async ensureFolderExists(folder: string): Promise<void> {
		const normalized = normalizePath(folder);
		if (this.app.vault.getAbstractFileByPath(normalized)) return;
		await this.app.vault.createFolder(normalized);
	}

	private invalidateHoverCacheForCitekey(citekey: string) {
		const canonical = this.canonicalCitekey(citekey);
		for (const key of Array.from(this._hoverDataCache.keys())) {
			if (key.endsWith(`::${canonical}`)) {
				this._hoverDataCache.delete(key);
			}
		}
	}

	private async applySourceFrontmatter(file: TFile, citekey: string, title: string, raw?: Record<string, unknown>): Promise<void> {
		await this.loadDiscourseConfigIfNeeded();
		const defaults = await this.loadSourceTemplateDefaults();
		const citationPatch = this.citationFrontmatterPatch(citekey, title, raw);
		await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
			for (const [k, v] of Object.entries(defaults)) {
				if (frontmatter[k] === undefined || frontmatter[k] === null || frontmatter[k] === '') {
					frontmatter[k] = v;
				}
			}
			for (const [k, v] of Object.entries(citationPatch)) {
				if (frontmatter[k] === undefined || frontmatter[k] === null || frontmatter[k] === '') {
					frontmatter[k] = v;
				}
			}
			if (this._discourseSourceNodeTypeId && !frontmatter.nodeTypeId) frontmatter.nodeTypeId = this._discourseSourceNodeTypeId;
			if (!frontmatter.dg_type) frontmatter.dg_type = 'Source';
			if (!frontmatter.citekey) frontmatter.citekey = citekey;
			if (title && !frontmatter.title) frontmatter.title = title;
			if (!Array.isArray(frontmatter.tags)) frontmatter.tags = ['dg/source'];
			else if (!frontmatter.tags.includes('dg/source')) frontmatter.tags.push('dg/source');
		});
	}

	private async loadDiscourseConfigIfNeeded(): Promise<void> {
		if (this._discourseConfigLoaded) return;
		this._discourseConfigLoaded = true;
		try {
			const cfgPath = normalizePath(`${this.app.vault.configDir}/plugins/discourse-graphs/data.json`);
			const raw = await this.app.vault.adapter.read(cfgPath);
			const cfg = JSON.parse(raw) as Record<string, unknown>;
			if (typeof cfg.nodesFolderPath === 'string' && cfg.nodesFolderPath.trim().length > 0) {
				this._discourseNodesFolderPath = cfg.nodesFolderPath.trim();
			}
			if (Array.isArray(cfg.nodeTypes)) {
				const sourceType = cfg.nodeTypes.find((node: unknown) => {
					if (!node || typeof node !== 'object') return false;
					const n = node as Record<string, unknown>;
					const name = typeof n.name === 'string' ? n.name.toLowerCase() : '';
					const format = typeof n.format === 'string' ? n.format : '';
					return name === 'source' || format.startsWith('@');
				}) as Record<string, unknown> | undefined;
				this._discourseSourceNodeTypeId = sourceType && typeof sourceType.id === 'string' ? sourceType.id : null;
			}
		} catch (_err) {
			// Optional integration: keep going when discourse-graphs is unavailable.
		}
	}

	private async loadSourceTemplateDefaults(): Promise<Record<string, unknown>> {
		const defaults: Record<string, unknown> = {
			dg_type: 'Source',
			status: 'seed',
			keywords: '',
			rating: 3,
			tags: ['dg/source'],
		};
		try {
			const configuredPath = (this.settings.sourceTemplatePath || '').trim();
			if (!configuredPath) return defaults;
			const path = normalizePath(configuredPath);
			const content = await this.app.vault.adapter.read(path);
			const match = content.match(/^---\n([\s\S]*?)\n---/);
			if (!match) return defaults;
			for (const line of match[1].split('\n')) {
				const m = line.match(/^\s*([A-Za-z0-9_]+)\s*:\s*(.*)\s*$/);
				if (!m) continue;
				const key = m[1];
				const raw = m[2];
				if (raw === '""' || raw === "''") defaults[key] = '';
				else if (raw.startsWith('[') && raw.endsWith(']')) {
					defaults[key] = raw.slice(1, -1).split(',').map((x) => x.trim()).filter(Boolean).map((x) => x.replace(/^['\"]|['\"]$/g, ''));
				} else if (!Number.isNaN(Number(raw)) && raw !== '') defaults[key] = Number(raw);
				else defaults[key] = raw.replace(/^['\"]|['\"]$/g, '');
			}
		} catch (_err) {
			// ignore
		}
		return defaults;
	}

	private async tryBootstrapDiscourseSource(file: TFile): Promise<void> {
		if (!file || file.extension !== 'md') return;
		if (!this.settings.autoBootstrapSourcePages) return;
		if (!file.basename.startsWith('@')) return;

		await this.loadDiscourseConfigIfNeeded();
		const sourceFolder = (this.settings.sourceNotesFolderPath || this._discourseNodesFolderPath || 'source').trim();
		await this.ensureFolderExists(sourceFolder);
		const targetPath = normalizePath(`${sourceFolder}/${file.name}`);
		let targetFile = file;

		if (file.path !== targetPath) {
			const existing = this.app.vault.getAbstractFileByPath(targetPath);
			if (!existing) {
				await this.app.fileManager.renameFile(file, targetPath);
				const moved = this.app.vault.getAbstractFileByPath(targetPath);
				if (moved instanceof TFile) targetFile = moved;
			}
		}

		const key = targetFile.basename.replace(/^@+/, '');
		const active = this.app.workspace.getActiveFile();
		const cache = active ? this.app.metadataCache.getFileCache(active) : null;
		const scope = this.resolveScopeFromFrontmatter(cache?.frontmatter as Record<string, unknown> | undefined);
		const lookup = await this.getCitationMapFor(scope, [key]);
		await this.applySourceFrontmatter(targetFile, key, '', lookup.get(key));
	}

	async onload() {
		await this.loadSettings();

		this.registerEditorSuggest(new CitationSuggest(this.app, this));
		this.registerView(ReferencesViewType, (leaf: WorkspaceLeaf) => new ReferencesView(leaf, this));

		this.addCommand({
			id: 'open-zotero-search-panel',
			name: 'Zotsidian: Open Zotero Search Panel',
			hotkeys: [{ modifiers: ['Mod', 'Shift'], key: 'u' }],
			callback: () => {
				this.openSearchPanel();
			}
		});

		this.registerEvent(this.app.workspace.on('file-open', async (file: TFile | null) => {
			if (!file) {
				this.syncActiveBaseViewSupport(this.app.workspace.activeLeaf ?? this.app.workspace.getMostRecentLeaf());
				await this.setActiveFilePath('');
				return;
			}
			await this.tryBootstrapDiscourseSource(file);
			this.syncActiveBaseViewSupport(this.app.workspace.activeLeaf ?? this.app.workspace.getMostRecentLeaf());
			await this.setActiveFilePath(file.path);
		}));

		this.registerEvent(this.app.workspace.on('active-leaf-change', async (leaf: WorkspaceLeaf | null) => {
			this.syncActiveBaseViewSupport(leaf);
			const file = this.getLeafFile(leaf) ?? this.app.workspace.getActiveFile();
			if (!file) {
				await this.setActiveFilePath('');
				return;
			}
			if (file.path === this.activeFilePath) {
				await this.view?.renderReferences();
				return;
			}
			await this.setActiveFilePath(file.path);
		}));

		this.registerEvent(this.app.workspace.on('editor-menu', (menu, editor) => {
			menu.addItem((item) => {
				item.setTitle('Zotsidian');
				item.setIcon('graduation-cap');
				item.onClick(() => {
					editor.replaceSelection('@');
				});
			});
		}));

		this.registerEditorExtension(createCitationHoverExtension(this));
		this.registerDomEvent(document, 'mouseover', (event: MouseEvent) => this.handleDocumentMouseOver(event));
		this.registerDomEvent(document, 'mouseout', (event: MouseEvent) => this.handleDocumentMouseOut(event));
		this.registerDomEvent(document, 'mousedown', (event: MouseEvent) => this.handleDocumentMouseDown(event));

		this.addSettingTab(new ZotsidianSettingTab(this.app, this));

		this.app.workspace.onLayoutReady(async () => {
			await this.initLeaf();
			this.syncActiveBaseViewSupport(this.app.workspace.activeLeaf ?? this.app.workspace.getMostRecentLeaf());
			if (this.settings.preloadIndexOnStartup) {
				this.ensureCitationIndex(this.settings.defaultZoteroScope, false)
					.catch((err) => console.error('Zotsidian index preload failed:', err));
			}
		});

		if (this.settings.indexRefreshMinutes > 0) {
			const ms = this.settings.indexRefreshMinutes * 60 * 1000;
			this.registerInterval(window.setInterval(() => {
				const scope = this.settings.defaultZoteroScope || 'My Library';
				this.ensureCitationIndex(scope, true).catch(() => {
					/* noop */
				});
			}, ms));
		}
	}

	onunload() {
		if (this._persistDataTimer != null) {
			window.clearTimeout(this._persistDataTimer);
			this._persistDataTimer = null;
		}
		this.clearBaseViewObserver();
		this.hideBaseHoverCard();
		// keep custom view attached per Obsidian plugin guidelines
	}

	async loadSettings() {
		const loaded = (await this.loadData()) as ZotsidianStoredData | null;
		const migrated = Object.assign({}, loaded || {}) as Record<string, unknown>;
		const rawInternal = migrated._internal;
		delete migrated._internal;
		if (typeof migrated.defaultZoteroScope !== 'string' && typeof migrated.defaultBibliographyPath === 'string') {
			migrated.defaultZoteroScope = migrated.defaultBibliographyPath;
		}
		this._internalState = this.normalizeInternalState(rawInternal);
		this.settings = Object.assign({}, DEFAULT_SETTINGS, migrated);
		if (!['pandoc', 'plain', 'wikilink'].includes(this.settings.citationInsertFormat)) {
			this.settings.citationInsertFormat = 'pandoc';
		}
		if (!['pdf-first', 'zotero-first'].includes(this.settings.citationHoverOpenAction)) {
			this.settings.citationHoverOpenAction = 'pdf-first';
		}
		if (!['auto', 'semantic-scholar', 'openalex'].includes(this.settings.relatedPapersProvider)) {
			this.settings.relatedPapersProvider = 'auto';
		}
	}

	async saveSettings() {
		const cleanSettings: ZotsidianSettings = {
			defaultZoteroScope: this.settings.defaultZoteroScope,
			localLibraryJsonPath: this.settings.localLibraryJsonPath,
			autocompleteMinQueryLength: this.settings.autocompleteMinQueryLength,
			searchPanelMaxResults: this.settings.searchPanelMaxResults,
			normalizeCitekeyOnInsert: this.settings.normalizeCitekeyOnInsert,
			preloadIndexOnStartup: this.settings.preloadIndexOnStartup,
			indexRefreshMinutes: this.settings.indexRefreshMinutes,
			autoBootstrapSourcePages: this.settings.autoBootstrapSourcePages,
			autoCreateSourceOnCitationSelect: this.settings.autoCreateSourceOnCitationSelect,
			sourceNotesFolderPath: this.settings.sourceNotesFolderPath,
			sourceTemplatePath: this.settings.sourceTemplatePath,
			enableSidebarAttachments: this.settings.enableSidebarAttachments,
			showSourceRelatedPapers: this.settings.showSourceRelatedPapers,
			relatedPapersProvider: this.settings.relatedPapersProvider,
			citationInsertFormat: this.settings.citationInsertFormat,
			showCitationHoverCard: this.settings.showCitationHoverCard,
			citationHoverOpenAction: this.settings.citationHoverOpenAction,
			showJsonFallbackSettingInAdvanced: this.settings.showJsonFallbackSettingInAdvanced,
		};
		this.settings = cleanSettings;
		await this.saveData(this.buildStoredData());
	}

	get view() {
		const leaves = this.app.workspace.getLeavesOfType(ReferencesViewType);
		if (!leaves?.length) return null;
		if (leaves[0].view instanceof ReferencesView) return leaves[0].view;
		return null;
	}

	async initLeaf() {
		if (this.app.workspace.getLeavesOfType(ReferencesViewType).length) return;
		const leaf = this.app.workspace.getRightLeaf(false);
		if (!leaf) return;
		await leaf.setViewState({ type: ReferencesViewType });
	}

	async revealLeaf() {
		const leaves = this.app.workspace.getLeavesOfType(ReferencesViewType);
		if (!leaves?.length) return;
		await this.app.workspace.revealLeaf(leaves[0]);
	}
}
