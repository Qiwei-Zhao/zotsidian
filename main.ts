import { App, MarkdownView, Notice, Plugin, PluginSettingTab, Setting, TFile, WorkspaceLeaf, normalizePath } from 'obsidian';

import { CitationSuggest } from "CitationSuggest";
import { ReferencesView, ReferencesViewType } from 'ReferencesView';
import { SearchPanelModal } from 'SearchPanelModal';
import { FrontMatterScopeProperty } from 'FrontMatter';
import { createCitationHoverCardElement, createCitationHoverExtension } from 'EditorExtensions';
import { attachments, exportCollectionPath, normalizeExportItems, libraryCitekeysTitles, locateCollection, localApiLibraryIndex, resolveCitekeysToItems, resolveCitekeysToItemsViaLocalApi, type AttachmentLookupHint } from 'ZoteroFunctions';
import { fetchSourceRelatedPapers, normalizeDoi, type SemanticRelatedPaper, type RelatedPapersProvider } from 'SemanticScholar';
import { citationsInText, extractCitationMentions } from 'ReferenceProcessing';
import {
	buildDiscourseCanvasModel,
	type DiscourseCanvasModel,
	type DiscourseCanvasNodeEntry,
} from 'DiscourseCanvasModel';
import {
	getDiscourseCanvasActivePageId,
	getDiscourseCanvasGeometryHitFromModel,
	getDiscourseCanvasViewport,
	getRenderedDiscourseShapeElement,
} from 'DiscourseCanvasGeometry';
import {
	resolveHoveredDiscoursePrimaryCitekeyFromModel,
	resolveSelectedDiscourseContextFromModel,
	resolveSelectedDiscourseSourceCitekeyFromModel,
} from 'DiscourseCanvasSelection';
import {
	syncDiscourseHover,
	syncDiscourseSelection,
} from 'DiscourseCanvasSync';
import {
	getDiscourseStoreCameraRecord,
	getDiscourseStoreCurrentPageId,
	getDiscourseStoreCurrentPageState,
	getDiscourseStoreHoveredShapeId,
	getDiscourseStoreInstanceRecord,
	getDiscourseStorePageStateRecord,
	getDiscourseStoreRecords,
	getDiscourseStoreSelectedShapeIds,
	getDiscourseViewStore,
} from 'DiscourseStore';

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
	zoteroDataDir: string;
	showSourceRelatedPapers: boolean;
	relatedPapersProvider: RelatedPapersProvider;
	citationInsertFormat: CitationInsertFormat;
	showCitationHoverCard: boolean;
	citationHoverOpenAction: CitationHoverOpenAction;
	enableDiscourseGraphsCompatibility: boolean;
	discourseGraphVisibleNodeTypeIds: string[];
	enableDiscourseDebugLogging: boolean;
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

export type DiscourseNodeTypeInfo = {
	id: string;
	name: string;
	format: string;
	color: string;
};

export type DiscourseNodeLocateTarget = {
	id: string;
	kind: 'markdown-node-link' | 'canvas-discourse-node' | 'base-node-link';
	nodeId: string;
	title: string;
	filePath: string | null;
	nodeTypeId: string | null;
	nodeTypeName: string;
	order: number;
	label: string;
	line?: number;
	from?: { line: number; ch: number };
	to?: { line: number; ch: number };
	shapeId?: string;
	pageId?: string;
	domId?: string;
};

export type DiscourseNodeSidebarItem = {
	id: string;
	title: string;
	filePath: string | null;
	nodeTypeId: string | null;
	nodeTypeName: string;
	nodeTypeColor: string;
	targets: DiscourseNodeLocateTarget[];
};

type NativeCanvasNodeEntry = {
	id: string;
	type: string;
	text: string;
	filePath: string | null;
};

type CachedDiscourseCanvasNodeMap = DiscourseCanvasModel;

type SidebarSelectedContextKind = 'node' | 'text' | 'multi';

type SidebarSelectedContext = {
	filePath: string;
	kind: SidebarSelectedContextKind;
	citekeys: string[];
	source: 'canvas-selection' | 'canvas-source-node' | 'editor-line' | 'base-selection';
};

type SidebarFocusedDiscourseNodes = {
	filePath: string;
	nodeIds: string[];
	source: 'canvas-selection' | 'editor-line' | 'base-selection';
};

type BaseSelectionAnchor = {
	citekeys: string[];
	nodeIds: string[];
	at: number;
};

export type ReferenceLocateTarget = {
	id: string;
	kind: 'markdown' | 'canvas-node' | 'canvas-text' | 'base-dom';
	citekey: string;
	order: number;
	label: string;
	notePath?: string;
	line?: number;
	from?: { line: number; ch: number };
	to?: { line: number; ch: number };
	shapeId?: string;
	pageId?: string;
	allCitekeys?: string[];
	domId?: string;
	domKind?: 'canvas-node' | 'base-cell';
};

export type ReferenceOccurrenceSummary = {
	count: number;
	kind: 'markdown' | 'canvas' | 'mixed' | null;
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
	zoteroDataDir: '',
	showSourceRelatedPapers: true,
	relatedPapersProvider: 'auto',
	citationInsertFormat: 'pandoc',
	showCitationHoverCard: true,
	citationHoverOpenAction: 'pdf-first',
	enableDiscourseGraphsCompatibility: true,
	discourseGraphVisibleNodeTypeIds: [],
	enableDiscourseDebugLogging: false,
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
			.setName('Zotero data directory')
			.setDesc('Optional absolute path to your Zotero data directory. Used to reconstruct image annotation previews when Zotero does not return a preview path directly.')
			.addText((text) => {
				text
					.setPlaceholder('Optional')
					.setValue(this.plugin.settings.zoteroDataDir)
					.onChange(async (value) => {
						this.plugin.settings.zoteroDataDir = value?.trim() || '';
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
			.setName('Discourse Graphs compatibility mode')
			.setDesc('Enable gray discourse-node support by mapping clicked node shapes from the discourse canvas file. Plain-text citekey hover remains enabled.')
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.enableDiscourseGraphsCompatibility)
					.onChange(async (value) => {
						this.plugin.settings.enableDiscourseGraphsCompatibility = value;
						await this.plugin.saveSettings();
						await this.plugin.renderSidebarView();
						this.display();
					});
			});

		if (this.plugin.settings.enableDiscourseGraphsCompatibility) {
			containerEl.createEl('h3', { text: 'Discourse Graph' });
			const nodeTypeContainer = containerEl.createDiv();
			nodeTypeContainer.createDiv({
				text: 'Loading discourse node types...',
				cls: 'setting-item-description',
			});
			void this.renderDiscourseNodeTypeSettings(nodeTypeContainer);
		}

		new Setting(containerEl)
			.setName('Discourse canvas debug logging')
			.setDesc('Log discourse-canvas page detection and click/selection resolution to the developer console. Keep this off unless we are debugging compatibility issues.')
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.enableDiscourseDebugLogging)
					.onChange(async (value) => {
						this.plugin.settings.enableDiscourseDebugLogging = value;
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

	private async renderDiscourseNodeTypeSettings(containerEl: HTMLElement): Promise<void> {
		containerEl.empty();
		await this.plugin.loadDiscourseConfigIfNeeded();
		const nodeTypes = this.plugin.getDiscourseNodeTypes();
		if (nodeTypes.length === 0) {
			containerEl.createDiv({
				text: 'No discourse node types were found in this vault.',
				cls: 'setting-item-description',
			});
			return;
		}

		containerEl.createDiv({
			text: 'Choose which discourse node types appear in the sidebar panel. If none are selected, all node types are shown.',
			cls: 'setting-item-description',
		});

		const selectedIds = new Set(this.plugin.settings.discourseGraphVisibleNodeTypeIds || []);
		for (const nodeType of nodeTypes) {
			new Setting(containerEl)
				.setName(`Show ${nodeType.name}`)
				.setDesc(nodeType.format || nodeType.id)
				.addToggle((toggle) => {
					toggle
						.setValue(selectedIds.size === 0 || selectedIds.has(nodeType.id))
						.onChange(async (value) => {
							const rawSelected = this.plugin.settings.discourseGraphVisibleNodeTypeIds || [];
							const nextSelected = rawSelected.length === 0
								? new Set(nodeTypes.map((entry) => entry.id))
								: new Set(rawSelected);
							if (value) {
								nextSelected.add(nodeType.id);
							} else {
								nextSelected.delete(nodeType.id);
							}
							this.plugin.settings.discourseGraphVisibleNodeTypeIds = nextSelected.size === nodeTypes.length
								? []
								: Array.from(nextSelected);
							await this.plugin.saveSettings();
							await this.plugin.renderSidebarView();
						});
				});
		}

		new Setting(containerEl)
			.setName('Reset node type filter')
			.setDesc('Clear the node type filter and show every discourse node type in the sidebar.')
			.addButton((button) => {
				button.setButtonText('Show all');
				button.onClick(async () => {
					this.plugin.settings.discourseGraphVisibleNodeTypeIds = [];
					await this.plugin.saveSettings();
					await this.plugin.renderSidebarView();
					this.display();
				});
			});
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
	private _discourseNodeTypes: DiscourseNodeTypeInfo[] = [];
	private _relatedDataCache: Map<string, Promise<SourceRelatedData | null>> = new Map();
	private _hoverDataCache: Map<string, Promise<CitationHoverData | null>> = new Map();
	private _baseViewObserver: MutationObserver | null = null;
	private _baseViewRootCleanup: (() => void) | null = null;
	private _baseViewRefreshTimer: number | null = null;
	private _baseHoverCardEl: HTMLElement | null = null;
	private _baseHoverTargetEl: HTMLElement | null = null;
	private _baseHoverRootEl: HTMLElement | null = null;
	private _baseHoverHideTimer: number | null = null;
	private _baseHoverSwitchTimer: number | null = null;
	private _suppressBaseHoverUntil: number = 0;
	private _discourseFocusResolveToken: number = 0;
	private _discourseSelectionSyncTimer: number | null = null;
	private _discourseStatePollTimer: number | null = null;
	private _discourseLocateSuppressUntil: number = 0;
	private _lastDiscourseSelectionSyncStateKey: string | null = null;
	private _lastCanvasClickContext: { filePath: string; x: number; y: number; at: number; candidate?: string | null } | null = null;
	private _lastDiscourseInteraction: { filePath: string; type: string; x: number; y: number; at: number } | null = null;
	private _persistDataTimer: number | null = null;
	private _internalState: InternalPluginState = { citationIndexCacheByScope: {} };
	private _sidebarSelectedContext: SidebarSelectedContext | null = null;
	private _sidebarFocusedDiscourseNodes: SidebarFocusedDiscourseNodes | null = null;
	private _discourseCanvasNodesByFile: Map<string, CachedDiscourseCanvasNodeMap> = new Map();
	private _lastMarkdownLineSelection: { filePath: string; line: number; citekeys: string[] } | null = null;
	private _referenceLocateCycleByKey: Map<string, number> = new Map();
	private _markdownLocateFlashTimer: number | null = null;
	private _baseSelectionAnchorByFile: Map<string, BaseSelectionAnchor> = new Map();

	get activeFilePath() {
		return this._activeFilePath;
	}

	openSearchPanel(scope?: string) {
		const active = this.app.workspace.getActiveFile();
		const cache = active ? this.app.metadataCache.getFileCache(active) : null;
		const resolved = scope || this.resolveScopeFromFrontmatter(cache?.frontmatter as Record<string, unknown> | undefined);
		new SearchPanelModal(this.app, this, resolved, this.settings.searchPanelMaxResults || 80).open();
	}

	async renderSidebarView() {
		await this.view?.renderReferences();
	}

	async refreshSidebarView() {
		await this.view?.refreshReferences();
		await this.renderSidebarView();
	}

	private normalizeSidebarSelectedCitekeys(citekeys: string[]): string[] {
		const normalized: string[] = [];
		const seen = new Set<string>();
		for (const raw of citekeys) {
			const clean = (raw || '').replace(/^@+/, '').trim();
			if (!clean) continue;
			const canonical = this.canonicalCitekey(clean);
			if (!canonical || seen.has(canonical)) continue;
			seen.add(canonical);
			normalized.push(clean);
		}
		return normalized;
	}

	private sameSidebarSelectedContext(a: SidebarSelectedContext | null, b: SidebarSelectedContext | null): boolean {
		if (a === b) return true;
		if (!a || !b) return false;
		if (a.filePath !== b.filePath || a.kind !== b.kind || a.source !== b.source) return false;
		if (a.citekeys.length !== b.citekeys.length) return false;
		return a.citekeys.every((citekey, index) => this.canonicalCitekey(citekey) === this.canonicalCitekey(b.citekeys[index] || ''));
	}

	getSidebarSelectedContext(filePath?: string): SidebarSelectedContext | null {
		if (!this._sidebarSelectedContext) return null;
		if (filePath && this._sidebarSelectedContext.filePath !== filePath) return null;
		return {
			...this._sidebarSelectedContext,
			citekeys: [...this._sidebarSelectedContext.citekeys],
		};
	}

	getSidebarFocusedCitekey(filePath?: string): string | null {
		return this.getSidebarSelectedContext(filePath)?.citekeys[0] || null;
	}

	private sameSidebarFocusedDiscourseNodes(a: SidebarFocusedDiscourseNodes | null, b: SidebarFocusedDiscourseNodes | null): boolean {
		if (a === b) return true;
		if (!a || !b) return false;
		if (a.filePath !== b.filePath || a.source !== b.source) return false;
		if (a.nodeIds.length !== b.nodeIds.length) return false;
		return a.nodeIds.every((nodeId, index) => nodeId === (b.nodeIds[index] || ''));
	}

	getSidebarFocusedDiscourseNodes(filePath?: string): string[] {
		if (!this._sidebarFocusedDiscourseNodes) return [];
		if (filePath && this._sidebarFocusedDiscourseNodes.filePath !== filePath) return [];
		return [...this._sidebarFocusedDiscourseNodes.nodeIds];
	}

	async setSidebarSelectedContext(
		context: Omit<SidebarSelectedContext, 'filePath' | 'citekeys'> & { citekeys: string[] },
		filePath: string
	) {
		if (!filePath) return;
		const citekeys = this.normalizeSidebarSelectedCitekeys(context.citekeys);
		if (citekeys.length === 0) {
			await this.clearSidebarSelectedContext(filePath);
			return;
		}
		const next: SidebarSelectedContext = {
			filePath,
			kind: citekeys.length > 1 ? 'multi' : context.kind,
			citekeys,
			source: context.source,
		};
		if (this.sameSidebarSelectedContext(this._sidebarSelectedContext, next)) return;
		this._sidebarSelectedContext = next;
		await this.renderSidebarView();
	}

	async setSidebarFocusedCitekey(citekey: string, filePath: string) {
		await this.setSidebarSelectedContext(
			{
				kind: 'node',
				citekeys: [citekey],
				source: 'canvas-source-node',
			},
			filePath
		);
	}

	async clearSidebarSelectedContext(filePath?: string) {
		if (!this._sidebarSelectedContext) return;
		if (filePath && this._sidebarSelectedContext.filePath !== filePath) return;
		this._sidebarSelectedContext = null;
		await this.renderSidebarView();
	}

	async clearSidebarFocusedCitekey(filePath?: string) {
		await this.clearSidebarSelectedContext(filePath);
	}

	async setSidebarFocusedDiscourseNodes(nodeIds: string[], filePath: string, source: SidebarFocusedDiscourseNodes['source']) {
		if (!filePath) return;
		const normalized = Array.from(new Set(nodeIds.map((nodeId) => nodeId.trim()).filter(Boolean)));
		if (normalized.length === 0) {
			await this.clearSidebarFocusedDiscourseNodes(filePath);
			return;
		}
		const next: SidebarFocusedDiscourseNodes = {
			filePath,
			nodeIds: normalized,
			source,
		};
		if (this.sameSidebarFocusedDiscourseNodes(this._sidebarFocusedDiscourseNodes, next)) return;
		this._sidebarFocusedDiscourseNodes = next;
		await this.view?.renderReferences();
	}

	async clearSidebarFocusedDiscourseNodes(filePath?: string) {
		if (!this._sidebarFocusedDiscourseNodes) return;
		if (filePath && this._sidebarFocusedDiscourseNodes.filePath !== filePath) return;
		this._sidebarFocusedDiscourseNodes = null;
		await this.view?.renderReferences();
	}

	async setActiveFilePath(path: string) {
		if (path !== this._activeFilePath) {
			this._sidebarSelectedContext = null;
			this._lastMarkdownLineSelection = null;
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
			await this.refreshSidebarView();
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

	private discourseDebug(...args: unknown[]) {
		if (!this.settings.enableDiscourseDebugLogging) return;
		console.warn('[Zotsidian:discourse]', ...args);
	}

	private discourseSelectionSyncDebugOnce(kind: string, payload: Record<string, unknown>) {
		if (!this.settings.enableDiscourseDebugLogging) return;
		const key = `${kind}:${JSON.stringify(payload)}`;
		if (this._lastDiscourseSelectionSyncStateKey === key) return;
		this._lastDiscourseSelectionSyncStateKey = key;
		this.discourseDebug(kind, payload);
	}

	private summarizeDiscourseTarget(target: HTMLElement | null): Record<string, unknown> | null {
		if (!(target instanceof HTMLElement)) return null;
		const text = (target.innerText || target.textContent || '').replace(/\s+/g, ' ').trim();
		return {
			tag: target.tagName.toLowerCase(),
			className: target.className || '',
			dataShapeId: target.getAttribute('data-shape-id') || target.closest<HTMLElement>('[data-shape-id]')?.getAttribute('data-shape-id') || '',
			text: text.length > 120 ? `${text.slice(0, 117)}...` : text,
		};
	}

	private summarizeCitekeys(citekeys: string[]): string[] {
		const clean = citekeys.filter(Boolean);
		if (clean.length <= 12) return clean;
		return [...clean.slice(0, 12), `... (+${clean.length - 12} more)`];
	}

	private async dumpActiveDiscourseCanvasDebugSnapshot() {
		const leaf = this.app.workspace.activeLeaf ?? this.app.workspace.getMostRecentLeaf();
		if (!this.isDiscourseCanvasLeaf(leaf)) {
			new Notice('Active leaf is not a discourse canvas.');
			return;
		}
		const file = this.getLeafFile(leaf) ?? this.app.workspace.getActiveFile();
		const root = this.getBaseViewRoot(leaf);
		if (!(file instanceof TFile) || !(root instanceof HTMLElement)) {
			new Notice('Could not resolve the active discourse canvas root.');
			return;
		}
		const model = await this.getDiscourseCanvasModel(file);
		const pageId = getDiscourseCanvasActivePageId(root, model);
		const pageCitekeys = pageId ? (model.pageCitekeys.get(pageId) || []) : [];
		const selectedCandidates = this.getSelectedDiscourseSourceNodeCandidates(root).map((candidate) => candidate.citekey);
		const visibleTextFallback = citationsInText(root.innerText || root.textContent || '');
		const storeCurrentPageId = getDiscourseStoreCurrentPageId(leaf);
		const storeSelectedShapeIds = getDiscourseStoreSelectedShapeIds(leaf);
		const storeHoveredShapeId = getDiscourseStoreHoveredShapeId(leaf);
		const snapshot = {
			filePath: file.path,
			pageId,
			currentPageId: model.currentPageId,
			storeCurrentPageId,
			storeSelectedShapeIds,
			storeHoveredShapeId,
			pageName: pageId ? (model.pageNames.get(pageId) || '') : '',
			pageCitekeys,
			nodesOnPage: pageId ? Array.from(model.nodes.values()).filter((node) => node.pageId === pageId).map((node) => node.citekey || node.title) : [],
			textShapesOnPage: pageId ? model.textShapes.filter((entry) => entry.pageId === pageId).map((entry) => ({ citekeys: entry.citekeys, text: entry.text.slice(0, 120) })) : [],
			selectedCandidates,
			sidebarFocused: this.getSidebarFocusedCitekey(file.path),
			sidebarSelectedContext: this.getSidebarSelectedContext(file.path),
			lastCanvasClickContext: this._lastCanvasClickContext,
			visibleTextFallback,
			root: this.summarizeDiscourseTarget(root),
		};
		console.warn('[Zotsidian:discourse] debug-snapshot', snapshot);
		new Notice('Zotsidian discourse debug snapshot logged to console.');
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
					.map((entry) => ({
						id: entry.id,
						title: entry.title,
						meta: entry.meta,
						raw: entry.raw,
					}));
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

	private isDiscourseCanvasLeaf(leaf: WorkspaceLeaf | null): boolean {
		if (!leaf) return false;
		const view = leaf.view as { getViewType?: () => string; type?: string; containerEl?: HTMLElement };
		const type = typeof view?.getViewType === 'function' ? view.getViewType() : (typeof view?.type === 'string' ? view.type : '');
		if (type === 'tldraw-dg-preview' || type.toLowerCase().includes('tldraw-dg')) return true;
		const container = view?.containerEl;
		return container instanceof HTMLElement && !!container.querySelector('.tldraw__editor, .tl-canvas, .tldraw-view-content');
	}

	private isBaseLeaf(leaf: WorkspaceLeaf | null): boolean {
		if (!leaf) return false;
		const file = this.getLeafFile(leaf);
		if (file?.extension === 'base' || file?.extension === 'canvas') return true;
		if (this.isDiscourseCanvasLeaf(leaf)) return true;
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
		const container = this.getBaseViewContainer(leaf);
		if (!(container instanceof HTMLElement)) return null;
		return (
			container.querySelector<HTMLElement>('.tldraw__editor') ||
			container.querySelector<HTMLElement>('.tl-canvas') ||
			container.querySelector<HTMLElement>('.canvas-wrapper') ||
			container.querySelector<HTMLElement>('.view-content') ||
			container.querySelector<HTMLElement>('.workspace-leaf-content') ||
			container
		);
	}

	private getBaseViewContainer(leaf: WorkspaceLeaf | null): HTMLElement | null {
		if (!this.isBaseLeaf(leaf)) return null;
		const view = leaf?.view as { containerEl?: HTMLElement } | undefined;
		const container = view?.containerEl;
		if (!(container instanceof HTMLElement)) return null;
		return container;
	}

	private getBaseLeafAndRootForFile(filePath: string): { leaf: WorkspaceLeaf; file: TFile; root: HTMLElement } | null {
		if (!filePath) return null;
		const leaves = new Set<WorkspaceLeaf>();
		const activeLeaf = this.app.workspace.activeLeaf;
		const recentLeaf = this.app.workspace.getMostRecentLeaf();
		if (activeLeaf) leaves.add(activeLeaf);
		if (recentLeaf) leaves.add(recentLeaf);
		this.app.workspace.iterateAllLeaves((leaf) => {
			leaves.add(leaf);
		});
		for (const leaf of leaves) {
			const file = this.getLeafFile(leaf) ?? this.app.workspace.getActiveFile();
			if (!(file instanceof TFile) || file.path !== filePath || !this.isBaseLeaf(leaf)) continue;
			const root = this.getBaseViewRoot(leaf);
			if (!(root instanceof HTMLElement)) continue;
			return { leaf, file, root };
		}
		return null;
	}

	private isSidebarTarget(target: HTMLElement | null, path?: EventTarget[]): boolean {
		if (!(target instanceof HTMLElement)) return false;
		if (target.closest('.zotsidian-container-div')) return true;
		return !!path?.some((entry) => entry instanceof HTMLElement && entry.classList.contains('zotsidian-container-div'));
	}

	private sameCitekeyList(a: string[], b: string[]): boolean {
		if (a.length !== b.length) return false;
		return a.every((citekey, index) => this.canonicalCitekey(citekey) === this.canonicalCitekey(b[index] || ''));
	}

	private async syncActiveMarkdownLineContext() {
		const activeLeaf = this.app.workspace.activeLeaf ?? this.app.workspace.getMostRecentLeaf();
		if (activeLeaf?.view instanceof ReferencesView) return;
		const view = activeLeaf?.view;
		if (!(view instanceof MarkdownView)) return;
		const file = this.getLeafFile(activeLeaf) ?? this.app.workspace.getActiveFile();
		if (!(file instanceof TFile)) return;
		if (this.isBaseLeaf(activeLeaf) || this.isDiscourseCanvasLeaf(activeLeaf)) return;

		if (view.getMode() !== 'source') {
			const existing = this.getSidebarSelectedContext(file.path);
			if (existing?.source === 'editor-line') {
				this._lastMarkdownLineSelection = null;
				await this.clearSidebarSelectedContext(file.path);
			}
			if (this._sidebarFocusedDiscourseNodes?.filePath === file.path && this._sidebarFocusedDiscourseNodes.source === 'editor-line') {
				await this.clearSidebarFocusedDiscourseNodes(file.path);
			}
			return;
		}

		const editor = view.editor;
		const cursor = editor.getCursor('head');
		const line = Math.max(0, Math.min(cursor.line, editor.lastLine()));
		const lineText = editor.getLine(line) || '';
		const citekeys = this.normalizeSidebarSelectedCitekeys(citationsInText(lineText));
		const nextSelection = { filePath: file.path, line, citekeys };
		if (
			this._lastMarkdownLineSelection &&
			this._lastMarkdownLineSelection.filePath === nextSelection.filePath &&
			this._lastMarkdownLineSelection.line === nextSelection.line &&
			this.sameCitekeyList(this._lastMarkdownLineSelection.citekeys, nextSelection.citekeys)
		) {
			const existing = this.getSidebarSelectedContext(file.path);
			if (existing?.source === 'editor-line' && this.sameCitekeyList(existing.citekeys, citekeys)) {
				return;
			}
		}

		this._lastMarkdownLineSelection = nextSelection;
		if (citekeys.length === 0) {
			const existing = this.getSidebarSelectedContext(file.path);
			if (existing?.source === 'editor-line') {
				await this.clearSidebarSelectedContext(file.path);
			}
		} else {
			await this.setSidebarSelectedContext(
				{
					kind: citekeys.length > 1 ? 'multi' : 'text',
					citekeys,
					source: 'editor-line',
				},
				file.path
			);
		}

		const focusedNodeIds: string[] = [];
		const mentions = this.extractMarkdownWikiLinkMentions(lineText);
		for (const mention of mentions) {
			const startCh = mention.from;
			const endCh = mention.to;
			if (cursor.ch < startCh || cursor.ch > endCh) continue;
			const linkedFile = this.resolveWikiLinkToFile(mention.rawLink, file.path);
			const nodeTypeId = this.getDiscourseNodeTypeIdForFile(linkedFile);
			if (!linkedFile || !nodeTypeId || !this.shouldShowDiscourseNodeType(nodeTypeId)) continue;
			focusedNodeIds.push(linkedFile.path);
		}
		if (focusedNodeIds.length > 0) {
			await this.setSidebarFocusedDiscourseNodes(focusedNodeIds, file.path, 'editor-line');
		} else if (this._sidebarFocusedDiscourseNodes?.filePath === file.path && this._sidebarFocusedDiscourseNodes.source === 'editor-line') {
			await this.clearSidebarFocusedDiscourseNodes(file.path);
		}
	}

	private getReferenceLocateCycleKey(filePath: string, citekey: string): string {
		return `${filePath}::${this.canonicalCitekey(citekey)}`;
	}

	private getLineStarts(text: string): number[] {
		const starts = [0];
		for (let index = 0; index < text.length; index++) {
			if (text[index] === '\n') {
				starts.push(index + 1);
			}
		}
		return starts;
	}

	private offsetToEditorPosition(lineStarts: number[], offset: number): { line: number; ch: number } {
		let low = 0;
		let high = lineStarts.length - 1;
		while (low <= high) {
			const mid = Math.floor((low + high) / 2);
			const start = lineStarts[mid];
			const next = mid + 1 < lineStarts.length ? lineStarts[mid + 1] : Number.POSITIVE_INFINITY;
			if (offset < start) {
				high = mid - 1;
				continue;
			}
			if (offset >= next) {
				low = mid + 1;
				continue;
			}
			return { line: mid, ch: offset - start };
		}
		const fallbackLine = Math.max(0, Math.min(lineStarts.length - 1, low));
		return { line: fallbackLine, ch: Math.max(0, offset - (lineStarts[fallbackLine] || 0)) };
	}

	private async getMarkdownReferenceLocateTargets(file: TFile, citekey: string): Promise<ReferenceLocateTarget[]> {
		const text = await this.app.vault.cachedRead(file);
		const canonical = this.canonicalCitekey(citekey);
		const mentions = extractCitationMentions(text).filter((mention) => this.canonicalCitekey(mention.citekey) === canonical);
		if (mentions.length === 0) return [];
		const lineStarts = this.getLineStarts(text);
		return mentions.map((mention, index) => {
			const from = this.offsetToEditorPosition(lineStarts, mention.from);
			const to = this.offsetToEditorPosition(lineStarts, mention.to);
			return {
				id: `markdown:${file.path}:${canonical}:${mention.from}:${index}`,
				kind: 'markdown',
				citekey,
				order: index,
				label: `Line ${from.line + 1}`,
				line: from.line,
				from,
				to,
			};
		});
	}

	private getDiscourseNodeTypeIdForFile(file: TFile | null | undefined): string | null {
		if (!(file instanceof TFile)) return null;
		const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined;
		const nodeTypeId = typeof frontmatter?.nodeTypeId === 'string' ? frontmatter.nodeTypeId : '';
		if (!nodeTypeId || !this.getDiscourseNodeTypeById(nodeTypeId)) return null;
		return nodeTypeId;
	}

	private extractMarkdownWikiLinkMentions(text: string): Array<{ rawLink: string; from: number; to: number }> {
		const mentions: Array<{ rawLink: string; from: number; to: number }> = [];
		const wikiLinkRe = /\[\[([^\]]+)\]\]/g;
		let match: RegExpExecArray | null;
		while ((match = wikiLinkRe.exec(text)) !== null) {
			const rawLink = (match[1] || '').trim();
			if (!rawLink) continue;
			mentions.push({
				rawLink,
				from: match.index,
				to: match.index + match[0].length,
			});
		}
		return mentions;
	}

	private resolveWikiLinkToFile(rawLink: string, sourcePath: string): TFile | null {
		const linkPath = (rawLink.split('|')[0] || rawLink).split('#')[0].trim();
		if (!linkPath) return null;
		return this.app.metadataCache.getFirstLinkpathDest(linkPath, sourcePath) || null;
	}

	private extractDiscourseBlockRefId(src: string): string | null {
		const value = (src || '').trim();
		if (!value) return null;
		if (value.startsWith('asset:')) {
			const raw = value.split(':')[1] || '';
			return raw.startsWith('blockref:') ? raw.slice('blockref:'.length) : null;
		}
		if (value.startsWith('blockref:')) {
			return value.slice('blockref:'.length);
		}
		return null;
	}

	private async getNativeCanvasNodes(file: TFile): Promise<NativeCanvasNodeEntry[]> {
		if (file.extension !== 'canvas' || this.isDiscourseCanvasLeaf(this.app.workspace.activeLeaf ?? this.app.workspace.getMostRecentLeaf())) {
			return [];
		}
		try {
			const raw = await this.app.vault.cachedRead(file);
			const parsed = JSON.parse(raw) as { nodes?: Array<Record<string, unknown>> };
			if (!Array.isArray(parsed?.nodes)) return [];
			return parsed.nodes.map((node): NativeCanvasNodeEntry | null => {
				const id = typeof node.id === 'string' ? node.id : '';
				const type = typeof node.type === 'string' ? node.type : '';
				if (!id || !type) return null;
				return {
					id,
					type,
					text: typeof node.text === 'string' ? node.text : '',
					filePath: typeof node.file === 'string' ? node.file : (typeof node.path === 'string' ? node.path : null),
				};
			}).filter((entry): entry is NativeCanvasNodeEntry => !!entry);
		} catch {
			return [];
		}
	}

	private getBaseSelectionAnchor(filePath: string): BaseSelectionAnchor | null {
		if (!filePath) return null;
		const anchor = this._baseSelectionAnchorByFile.get(filePath) || null;
		if (!anchor) return null;
		if (Date.now() - anchor.at > 12000) {
			this._baseSelectionAnchorByFile.delete(filePath);
			return null;
		}
		return anchor;
	}

	private setBaseSelectionAnchor(filePath: string, citekeys: string[], nodeIds: string[]) {
		if (!filePath) return;
		const normalizedCitekeys = this.normalizeSidebarSelectedCitekeys(citekeys);
		const normalizedNodeIds = Array.from(new Set(nodeIds.filter(Boolean)));
		if (normalizedCitekeys.length === 0 && normalizedNodeIds.length === 0) {
			this._baseSelectionAnchorByFile.delete(filePath);
			return;
		}
		this._baseSelectionAnchorByFile.set(filePath, {
			citekeys: normalizedCitekeys,
			nodeIds: normalizedNodeIds,
			at: Date.now(),
		});
	}

	private async resolveDiscourseNodeFileFromSrc(canvasFile: TFile, src: string): Promise<TFile | null> {
		const blockRefId = this.extractDiscourseBlockRefId(src);
		if (!blockRefId) return null;
		const canvasFileCache = this.app.metadataCache.getFileCache(canvasFile);
		const block = canvasFileCache?.blocks?.[blockRefId];
		if (!block) return null;
		try {
			const fileContent = await this.app.vault.cachedRead(canvasFile);
			const blockContent = fileContent.substring(block.position.start.offset, block.position.end.offset);
			const match = blockContent.match(/\[\[(.*?)\]\]/);
			if (!match?.[1]) return null;
			return this.resolveWikiLinkToFile(match[1].trim(), canvasFile.path);
		} catch {
			return null;
		}
	}

	private resolveDiscourseNodeFileFromTitle(title: string, sourcePath: string): TFile | null {
		const cleanTitle = (title || '').trim();
		if (!cleanTitle) return null;
		const direct = this.app.metadataCache.getFirstLinkpathDest(cleanTitle, sourcePath);
		if (direct instanceof TFile) {
			const nodeTypeId = this.getDiscourseNodeTypeIdForFile(direct);
			if (nodeTypeId) return direct;
		}
		const discourseNotes = this.app.vault.getMarkdownFiles().filter((note) => {
			const nodeTypeId = this.getDiscourseNodeTypeIdForFile(note);
			return !!nodeTypeId;
		});
		const normalized = cleanTitle.toLowerCase();
		const exactMatches = discourseNotes.filter((note) => note.basename.trim().toLowerCase() === normalized);
		return exactMatches.length === 1 ? exactMatches[0] : null;
	}

	private async getMarkdownDiscourseNodeLocateTargets(file: TFile): Promise<DiscourseNodeLocateTarget[]> {
		await this.loadDiscourseConfigIfNeeded();
		const text = await this.app.vault.cachedRead(file);
		const mentions = this.extractMarkdownWikiLinkMentions(text);
		if (mentions.length === 0) return [];
		const lineStarts = this.getLineStarts(text);
		const targets: DiscourseNodeLocateTarget[] = [];
		for (let index = 0; index < mentions.length; index += 1) {
			const mention = mentions[index];
			const linkedFile = this.resolveWikiLinkToFile(mention.rawLink, file.path);
			const nodeTypeId = this.getDiscourseNodeTypeIdForFile(linkedFile);
			if (!linkedFile || !nodeTypeId || !this.shouldShowDiscourseNodeType(nodeTypeId)) continue;
			const nodeType = this.getDiscourseNodeTypeById(nodeTypeId);
			const from = this.offsetToEditorPosition(lineStarts, mention.from);
			const to = this.offsetToEditorPosition(lineStarts, mention.to);
			targets.push({
				id: `markdown-node:${file.path}:${linkedFile.path}:${mention.from}:${index}`,
				kind: 'markdown-node-link',
				nodeId: linkedFile.path,
				title: linkedFile.basename,
				filePath: linkedFile.path,
				nodeTypeId,
				nodeTypeName: nodeType?.name || 'Node',
				order: targets.length,
				label: `Line ${from.line + 1}`,
				line: from.line,
				from,
				to,
			});
		}
		return targets;
	}

	private async getCanvasDiscourseNodeLocateTargets(file: TFile): Promise<DiscourseNodeLocateTarget[]> {
		await this.loadDiscourseConfigIfNeeded();
		const model = await this.getDiscourseCanvasModel(file);
		const canvasInfo = this.getDiscourseCanvasLeafAndFileForPath(file.path);
		const activePageId =
			canvasInfo?.file.path === file.path
				? getDiscourseStoreCurrentPageId(canvasInfo.leaf) || getDiscourseCanvasActivePageId(canvasInfo.root, model)
				: model.currentPageId;
		const pageId = activePageId || model.currentPageId || model.pageNames.keys().next().value || null;
		if (!pageId) return [];

		const pageNodes = Array.from(model.nodes.values())
			.filter((entry) => entry.pageId === pageId && !!entry.nodeTypeId && this.shouldShowDiscourseNodeType(entry.nodeTypeId))
			.sort((a, b) => (a.y - b.y) || (a.x - b.x));

		const targets: DiscourseNodeLocateTarget[] = [];
		for (const entry of pageNodes) {
			const linkedFile =
				(entry.src ? await this.resolveDiscourseNodeFileFromSrc(file, entry.src) : null)
				|| this.resolveDiscourseNodeFileFromTitle(entry.title || '', file.path);
			const nodeType = this.getDiscourseNodeTypeById(entry.nodeTypeId);
			const nodeId = linkedFile?.path || `${file.path}::${entry.shapeId}`;
			targets.push({
				id: `canvas-node-ref:${file.path}:${entry.shapeId}`,
				kind: 'canvas-discourse-node',
				nodeId,
				title: linkedFile?.basename || entry.title || 'Untitled node',
				filePath: linkedFile?.path || null,
				nodeTypeId: entry.nodeTypeId,
				nodeTypeName: nodeType?.name || 'Node',
				order: targets.length,
				label: nodeType?.name || 'Node',
				shapeId: entry.shapeId,
				pageId: entry.pageId,
			});
		}
		return targets;
	}

	private getBaseDiscourseNodeLocateTargets(file: TFile): DiscourseNodeLocateTarget[] {
		if (file.extension === 'canvas' && !this.isDiscourseCanvasLeaf(this.app.workspace.activeLeaf ?? this.app.workspace.getMostRecentLeaf())) {
			return [];
		}
		const context = this.getBaseLeafAndRootForFile(file.path);
		if (!context) return [];
		const targets: DiscourseNodeLocateTarget[] = [];
		let ordinal = 0;
		for (const element of this.getBaseLocateCandidateElements(context.root, file)) {
			if (this.isIgnoredBaseHoverElement(element)) continue;
			const nodeId = this.resolveDiscourseNodeIdFromElement(element, file.path);
			if (!nodeId) continue;
			const linkedAbstract = this.app.vault.getAbstractFileByPath(nodeId);
			const linkedFile = linkedAbstract instanceof TFile ? linkedAbstract : null;
			const nodeTypeId = this.getDiscourseNodeTypeIdForFile(linkedFile);
			if (!linkedFile || !nodeTypeId || !this.shouldShowDiscourseNodeType(nodeTypeId)) continue;
			const nodeType = this.getDiscourseNodeTypeById(nodeTypeId);
			targets.push({
				id: `base-node-ref:${file.path}:${nodeId}:${ordinal}`,
				kind: 'base-node-link',
				nodeId,
				title: linkedFile.basename,
				filePath: linkedFile.path,
				nodeTypeId,
				nodeTypeName: nodeType?.name || 'Node',
				order: targets.length,
				label: file.extension === 'canvas' ? 'Canvas node' : 'Visible cell',
				domId: element.getAttribute('data-node-id') || undefined,
			});
			ordinal += 1;
		}
		return targets;
	}

	private async getBaseDetectedDiscourseNodeLocateTargets(file: TFile): Promise<DiscourseNodeLocateTarget[]> {
		await this.loadDiscourseConfigIfNeeded();
		if (file.extension !== 'base') return [];
		const targets: DiscourseNodeLocateTarget[] = [];
		for (const note of await this.getBaseCandidateNoteFiles(file)) {
			const nodeTypeId = this.getDiscourseNodeTypeIdForFile(note);
			if (!nodeTypeId || !this.shouldShowDiscourseNodeType(nodeTypeId)) continue;
			const nodeType = this.getDiscourseNodeTypeById(nodeTypeId);
			targets.push({
				id: `base-node-file:${file.path}:${note.path}`,
				kind: 'base-node-link',
				nodeId: note.path,
				title: note.basename,
				filePath: note.path,
				nodeTypeId,
				nodeTypeName: nodeType?.name || 'Node',
				order: targets.length,
				label: 'Base row',
			});
		}
		return targets;
	}

	private async getNativeCanvasReferenceLocateTargets(file: TFile, citekey: string): Promise<ReferenceLocateTarget[]> {
		const canonical = this.canonicalCitekey(citekey);
		const nodes = await this.getNativeCanvasNodes(file);
		const targets: ReferenceLocateTarget[] = [];
		for (const node of nodes) {
			const text = node.text || (node.filePath ? `[[${node.filePath}]]` : '');
			const mentions = citationsInText(text).filter((item) => this.canonicalCitekey(item) === canonical);
			for (let index = 0; index < mentions.length; index += 1) {
				targets.push({
					id: `native-canvas:${file.path}:${node.id}:${index}`,
					kind: 'base-dom',
					citekey,
					order: targets.length,
					label: 'Canvas node',
					domId: node.id,
					domKind: 'canvas-node',
				});
			}
			if (node.filePath) {
				const linked = this.app.vault.getAbstractFileByPath(node.filePath);
				if (linked instanceof TFile && linked.basename.replace(/^@+/, '') === citekey.replace(/^@+/, '')) {
					targets.push({
						id: `native-canvas-file:${file.path}:${node.id}`,
						kind: 'base-dom',
						citekey,
						order: targets.length,
						label: 'Canvas file node',
						domId: node.id,
						domKind: 'canvas-node',
					});
				}
			}
		}
		return targets;
	}

	private async getNativeCanvasDiscourseNodeLocateTargets(file: TFile): Promise<DiscourseNodeLocateTarget[]> {
		await this.loadDiscourseConfigIfNeeded();
		const nodes = await this.getNativeCanvasNodes(file);
		const targets: DiscourseNodeLocateTarget[] = [];
		for (const node of nodes) {
			if (node.filePath) {
				const linked = this.app.vault.getAbstractFileByPath(node.filePath);
				if (linked instanceof TFile) {
					const nodeTypeId = this.getDiscourseNodeTypeIdForFile(linked);
					if (nodeTypeId && this.shouldShowDiscourseNodeType(nodeTypeId)) {
						const nodeType = this.getDiscourseNodeTypeById(nodeTypeId);
						targets.push({
							id: `native-canvas-node-file:${file.path}:${node.id}`,
							kind: 'base-node-link',
							nodeId: linked.path,
							title: linked.basename,
							filePath: linked.path,
							nodeTypeId,
							nodeTypeName: nodeType?.name || 'Node',
							order: targets.length,
							label: 'Canvas node',
							domId: node.id,
						});
					}
				}
			}
			for (const mention of this.extractMarkdownWikiLinkMentions(node.text || '')) {
				const linked = this.resolveWikiLinkToFile(mention.rawLink, file.path);
				const nodeTypeId = this.getDiscourseNodeTypeIdForFile(linked);
				if (!linked || !nodeTypeId || !this.shouldShowDiscourseNodeType(nodeTypeId)) continue;
				const nodeType = this.getDiscourseNodeTypeById(nodeTypeId);
				targets.push({
					id: `native-canvas-node-text:${file.path}:${node.id}:${targets.length}`,
					kind: 'base-node-link',
					nodeId: linked.path,
					title: linked.basename,
					filePath: linked.path,
					nodeTypeId,
					nodeTypeName: nodeType?.name || 'Node',
					order: targets.length,
					label: 'Canvas node',
					domId: node.id,
				});
			}
		}
		return targets;
	}

	private resolveReferenceFile(fileOrPath: TFile | string | null | undefined): TFile | null {
		if (fileOrPath instanceof TFile) return fileOrPath;
		if (typeof fileOrPath !== 'string' || !fileOrPath.trim()) return null;
		const abstract = this.app.vault.getAbstractFileByPath(fileOrPath.trim());
		return abstract instanceof TFile ? abstract : null;
	}

	private async getDiscourseReferenceLocateTargets(file: TFile): Promise<ReferenceLocateTarget[]> {
		const model = await this.getDiscourseCanvasModel(file);
		const canvasInfo = this.getDiscourseCanvasLeafAndFileForPath(file.path);
		const activePageId =
			canvasInfo?.file.path === file.path
				? getDiscourseStoreCurrentPageId(canvasInfo.leaf) || getDiscourseCanvasActivePageId(canvasInfo.root, model)
				: model.currentPageId;
		const pageId = activePageId || model.currentPageId || model.pageNames.keys().next().value || null;
		if (!pageId) return [];

		const targets: ReferenceLocateTarget[] = [];
		const nodeEntries = Array.from(model.nodes.values())
			.filter((entry) => entry.pageId === pageId && entry.citekey)
			.sort((a, b) => (a.y - b.y) || (a.x - b.x));
		nodeEntries.forEach((entry, index) => {
			if (!entry.citekey) return;
			targets.push({
				id: `canvas-node:${file.path}:${entry.shapeId}`,
				kind: 'canvas-node',
				citekey: entry.citekey,
				order: index,
				label: 'Node',
				shapeId: entry.shapeId,
				pageId,
				allCitekeys: [entry.citekey],
			});
		});

		const textEntries = model.textShapes
			.filter((entry) => entry.pageId === pageId && entry.citekeys.length > 0)
			.sort((a, b) => (a.y - b.y) || (a.x - b.x));
		textEntries.forEach((entry, index) => {
			for (const citekeyInShape of entry.citekeys) {
				targets.push({
					id: `canvas-text:${file.path}:${entry.shapeId}:${this.canonicalCitekey(citekeyInShape)}:${index}`,
					kind: 'canvas-text',
					citekey: citekeyInShape,
					order: targets.length,
					label: entry.citekeys.length > 1 ? `Text · ${entry.citekeys.length} cites` : 'Text',
					shapeId: entry.shapeId,
					pageId,
					allCitekeys: [...entry.citekeys],
				});
			}
		});

		return targets;
	}

	async getReferenceLocateTargetsForFile(fileOrPath: TFile | string | null | undefined, citekey: string): Promise<ReferenceLocateTarget[]> {
		const activeFile = this.resolveReferenceFile(fileOrPath);
		if (!(activeFile instanceof TFile)) return [];
		if (activeFile.extension === 'canvas' && !this.isDiscourseCanvasLeaf(this.app.workspace.activeLeaf ?? this.app.workspace.getMostRecentLeaf())) {
			return this.getNativeCanvasReferenceLocateTargets(activeFile, citekey);
		}
		if (activeFile.extension === 'base') {
			return this.getBaseFileReferenceLocateTargets(activeFile, citekey);
		}
		if (activeFile.extension === 'canvas') {
			return this.getBaseReferenceLocateTargets(activeFile, citekey);
		}
		const canonical = this.canonicalCitekey(citekey);
		if (activeFile.extension === 'md') {
			const canvasInfo = this.getDiscourseCanvasLeafAndFileForPath(activeFile.path);
			if (canvasInfo?.file.path === activeFile.path) {
				const targets = await this.getDiscourseReferenceLocateTargets(activeFile);
				return targets.filter((target) => this.canonicalCitekey(target.citekey) === canonical);
			}
			const targets = await this.getMarkdownReferenceLocateTargets(activeFile, citekey);
			return targets.filter((target) => this.canonicalCitekey(target.citekey) === canonical);
		}
		return [];
	}

	async getDiscourseCanvasDetectedCitations(file: TFile): Promise<string[] | null> {
		if (!(file instanceof TFile) || file.extension !== 'md') return null;
		const canvasInfo = this.getDiscourseCanvasLeafAndFileForPath(file.path);
		if (canvasInfo?.file.path !== file.path) return null;
		const targets = await this.getDiscourseReferenceLocateTargets(file);
		const citekeys = targets
			.map((target) => (target.citekey || '').replace(/^@+/, '').trim())
			.filter((citekey) => citekey.length > 0);
		return [...new Set(citekeys)];
	}

	private getBaseReferenceLocateTargets(file: TFile, citekey: string): ReferenceLocateTarget[] {
		if (file.extension === 'base') {
			return [];
		}
		const context = this.getBaseLeafAndRootForFile(file.path);
		if (!context) return [];
		const canonical = this.canonicalCitekey(citekey);
		const targets: ReferenceLocateTarget[] = [];
		let ordinal = 0;
		for (const element of this.getBaseLocateCandidateElements(context.root, file)) {
			if (this.isIgnoredBaseHoverElement(element)) continue;
			const text = this.normalizeHoverText(element.innerText || element.textContent || '');
			if (!text) continue;
			const mentions = citationsInText(text).filter((item) => this.canonicalCitekey(item) === canonical);
			if (mentions.length === 0) continue;
			const domId = element.getAttribute('data-node-id') || '';
			for (let index = 0; index < mentions.length; index += 1) {
				targets.push({
					id: `base-dom:${file.path}:${domId || ordinal}:${index}`,
					kind: 'base-dom',
					citekey,
					order: targets.length,
					label: file.extension === 'canvas' ? 'Canvas node' : 'Visible cell',
					domId: domId || undefined,
					domKind: file.extension === 'canvas' ? 'canvas-node' : 'base-cell',
				});
			}
			ordinal += 1;
		}
		return targets;
	}

	private async getBaseFileReferenceLocateTargets(file: TFile, citekey: string): Promise<ReferenceLocateTarget[]> {
		if (file.extension !== 'base') return [];
		const canonical = this.canonicalCitekey(citekey);
		const targets: ReferenceLocateTarget[] = [];
		for (const note of await this.getBaseCandidateNoteFiles(file)) {
			const frontmatter = this.app.metadataCache.getFileCache(note)?.frontmatter as Record<string, unknown> | undefined;
			const sourceRef = typeof frontmatter?.source_ref === 'string' ? frontmatter.source_ref : '';
			const titleCitekey = note.basename.startsWith('@') ? this.canonicalCitekey(note.basename) : '';
			if (titleCitekey === canonical) {
				targets.push({
					id: `base-file-note:${file.path}:${note.path}:${targets.length}`,
					kind: 'base-dom',
					citekey,
					order: targets.length,
					label: 'Base row',
					notePath: note.path,
					domKind: 'base-cell',
				});
			}
			const sourceMentions = citationsInText(sourceRef).filter((item) => this.canonicalCitekey(item) === canonical);
			for (let index = 0; index < sourceMentions.length; index += 1) {
				targets.push({
					id: `base-file-source-ref:${file.path}:${note.path}:${index}`,
					kind: 'base-dom',
					citekey,
					order: targets.length,
					label: 'Base row',
					notePath: note.path,
					domKind: 'base-cell',
				});
			}
			const text = await this.app.vault.cachedRead(note);
			const mentions = extractCitationMentions(text).filter((mention) => this.canonicalCitekey(mention.citekey) === canonical);
			for (let index = 0; index < mentions.length; index += 1) {
				targets.push({
					id: `base-file-text:${file.path}:${note.path}:${mentions[index].from}:${index}`,
					kind: 'base-dom',
					citekey,
					order: targets.length,
					label: 'Base row',
					notePath: note.path,
					domKind: 'base-cell',
				});
			}
		}
		return targets;
	}

	async getReferenceLocateTargetsForActiveFile(citekey: string): Promise<ReferenceLocateTarget[]> {
		return this.getReferenceLocateTargetsForFile(this.app.workspace.getActiveFile(), citekey);
	}

	async getNativeCanvasDetectedCitations(fileOrPath: TFile | string | null | undefined): Promise<string[]> {
		const file = this.resolveReferenceFile(fileOrPath);
		if (!(file instanceof TFile) || file.extension !== 'canvas') return [];
		const nodes = await this.getNativeCanvasNodes(file);
		const citekeys: string[] = [];
		for (const node of nodes) {
			const text = node.text || (node.filePath ? `[[${node.filePath}]]` : '');
			citekeys.push(...citationsInText(text));
			if (node.filePath) {
				const linked = this.app.vault.getAbstractFileByPath(node.filePath);
				if (linked instanceof TFile && linked.basename.startsWith('@')) {
					citekeys.push(linked.basename.replace(/^@+/, ''));
				}
			}
		}
		return this.normalizeSidebarSelectedCitekeys(citekeys);
	}

	private async getBaseFileContent(file: TFile): Promise<string> {
		try {
			return await this.app.vault.cachedRead(file);
		} catch {
			return '';
		}
	}

	private async getBaseCandidateNoteFiles(file: TFile): Promise<TFile[]> {
		if (file.extension !== 'base') return [];
		const raw = await this.getBaseFileContent(file);
		const notes = this.app.vault.getMarkdownFiles();
		if (raw.includes('file.hasProperty("nodeTypeId")')) {
			return notes.filter((note) => {
				const frontmatter = this.app.metadataCache.getFileCache(note)?.frontmatter as Record<string, unknown> | undefined;
				return typeof frontmatter?.nodeTypeId === 'string' && !!frontmatter.nodeTypeId;
			});
		}
		return notes;
	}

	async getBaseDetectedCitations(fileOrPath: TFile | string | null | undefined): Promise<string[]> {
		const file = this.resolveReferenceFile(fileOrPath);
		if (!(file instanceof TFile) || file.extension !== 'base') return [];
		const citekeys: string[] = [];
		for (const note of await this.getBaseCandidateNoteFiles(file)) {
			const frontmatter = this.app.metadataCache.getFileCache(note)?.frontmatter as Record<string, unknown> | undefined;
			if (note.basename.startsWith('@')) {
				citekeys.push(note.basename.replace(/^@+/, ''));
			}
			const sourceRef = typeof frontmatter?.source_ref === 'string' ? frontmatter.source_ref : '';
			if (sourceRef) {
				citekeys.push(...citationsInText(sourceRef));
			}
			const text = await this.app.vault.cachedRead(note);
			citekeys.push(...citationsInText(text));
		}
		return this.normalizeSidebarSelectedCitekeys(citekeys);
	}

	async getReferenceOccurrenceSummaryForFile(fileOrPath: TFile | string | null | undefined, citekey: string): Promise<ReferenceOccurrenceSummary> {
		const targets = await this.getReferenceLocateTargetsForFile(fileOrPath, citekey);
		if (targets.length === 0) return { count: 0, kind: null };
		const kinds = new Set(targets.map((target) => target.kind === 'markdown' ? 'markdown' : 'canvas'));
		if (kinds.size > 1) return { count: targets.length, kind: 'mixed' };
		return { count: targets.length, kind: (Array.from(kinds)[0] || null) as ReferenceOccurrenceSummary['kind'] };
	}

	async getReferenceOccurrenceSummaryForActiveFile(citekey: string): Promise<ReferenceOccurrenceSummary> {
		return this.getReferenceOccurrenceSummaryForFile(this.app.workspace.getActiveFile(), citekey);
	}

	async getDiscourseNodeSidebarItemsForFile(fileOrPath: TFile | string | null | undefined): Promise<DiscourseNodeSidebarItem[]> {
		if (!this.settings.enableDiscourseGraphsCompatibility) return [];
		await this.loadDiscourseConfigIfNeeded();
		const activeFile = this.resolveReferenceFile(fileOrPath);
		if (!(activeFile instanceof TFile)) return [];
		let targets: DiscourseNodeLocateTarget[] = [];
		if (activeFile.extension === 'md') {
			const canvasInfo = this.getDiscourseCanvasLeafAndFileForPath(activeFile.path);
			targets = canvasInfo?.file.path === activeFile.path
				? await this.getCanvasDiscourseNodeLocateTargets(activeFile)
				: await this.getMarkdownDiscourseNodeLocateTargets(activeFile);
		} else if (activeFile.extension === 'canvas' && !this.isDiscourseCanvasLeaf(this.app.workspace.activeLeaf ?? this.app.workspace.getMostRecentLeaf())) {
			targets = await this.getNativeCanvasDiscourseNodeLocateTargets(activeFile);
		} else if (activeFile.extension === 'base') {
			targets = await this.getBaseDetectedDiscourseNodeLocateTargets(activeFile);
			if (targets.length === 0) {
				targets = this.getBaseDiscourseNodeLocateTargets(activeFile);
			}
		} else if (activeFile.extension === 'canvas') {
			targets = this.getBaseDiscourseNodeLocateTargets(activeFile);
		}
		if (targets.length === 0) return [];

		const grouped = new Map<string, DiscourseNodeSidebarItem>();
		for (const target of targets) {
			const nodeType = this.getDiscourseNodeTypeById(target.nodeTypeId);
			const groupKey = target.nodeId || `${target.nodeTypeId || 'node'}::${target.title}`;
			const existing = grouped.get(groupKey);
			if (existing) {
				existing.targets.push(target);
				continue;
			}
			grouped.set(groupKey, {
				id: groupKey,
				title: target.title,
				filePath: target.filePath,
				nodeTypeId: target.nodeTypeId,
				nodeTypeName: target.nodeTypeName,
				nodeTypeColor: nodeType?.color || '',
				targets: [target],
			});
		}

		return Array.from(grouped.values()).map((item) => ({
			...item,
			targets: item.targets.sort((a, b) => a.order - b.order),
		}));
	}

	private async locateMarkdownNodeTarget(file: TFile, target: DiscourseNodeLocateTarget): Promise<boolean> {
		if (!target.from || !target.to) return false;
		return this.locateMarkdownTarget(file, {
			id: target.id,
			kind: 'markdown',
			citekey: target.title,
			order: target.order,
			label: target.label,
			line: target.line,
			from: target.from,
			to: target.to,
		});
	}

	private async locateCanvasDiscourseNodeTarget(file: TFile, target: DiscourseNodeLocateTarget): Promise<boolean> {
		if (!target.shapeId) return false;
		return this.locateDiscourseTarget(file, {
			id: target.id,
			kind: 'canvas-node',
			citekey: target.title,
			order: target.order,
			label: target.label,
			shapeId: target.shapeId,
			pageId: target.pageId,
			allCitekeys: [target.title],
		});
	}

	private async waitForBaseLocateElement(
		context: { leaf: WorkspaceLeaf; file: TFile; root: HTMLElement },
		resolveElement: () => HTMLElement | null,
	): Promise<HTMLElement | null> {
		let element: HTMLElement | null = resolveElement();
		if (element instanceof HTMLElement) return element;
		for (let attempt = 0; attempt < 8; attempt += 1) {
			await new Promise<void>((resolve) => window.setTimeout(resolve, 110));
			element = resolveElement();
			if (element instanceof HTMLElement) return element;
		}
		return null;
	}

	private async locateBaseDiscourseNodeTarget(file: TFile, target: DiscourseNodeLocateTarget): Promise<boolean> {
		const context = this.getBaseLeafAndRootForFile(file.path);
		if (!context) return false;
		const resolveElement = () => {
			let element: HTMLElement | null = null;
			if (target.domId) {
				element = context.root.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(target.domId)}"], .canvas-node[data-node-id="${CSS.escape(target.domId)}"]`);
			}
			if (element instanceof HTMLElement) return element;
			for (const candidate of this.getBaseLocateCandidateElements(context.root, file)) {
				if (this.resolveDiscourseNodeIdFromElement(candidate, file.path) === target.nodeId) {
					return candidate;
				}
			}
			return null;
		};
		let element: HTMLElement | null = resolveElement();
		if (!(element instanceof HTMLElement) && this.app.workspace.activeLeaf !== context.leaf) {
			await this.app.workspace.setActiveLeaf(context.leaf, { focus: true });
			element = await this.waitForBaseLocateElement(context, resolveElement);
		}
		if (!(element instanceof HTMLElement)) return false;
		if (this.app.workspace.activeLeaf !== context.leaf) {
			await this.app.workspace.setActiveLeaf(context.leaf, { focus: true });
		}
		const owner = file.extension === 'canvas'
			? (element.closest<HTMLElement>('[data-node-id], .canvas-node') || element)
			: (this.getBaseInteractionOwner(element, context.root) || element);
		this.setBaseSelectionAnchor(file.path, [], [target.nodeId]);
		owner.scrollIntoView({ block: 'center', behavior: 'smooth' });
		owner.classList.add('zotsidian-base-locate-flash');
		window.setTimeout(() => owner?.classList.remove('zotsidian-base-locate-flash'), 900);
		if (file.extension === 'canvas' && typeof owner.click === 'function') owner.click();
		if (typeof owner.focus === 'function') owner.focus();
		return true;
	}

	async locateDiscourseNodeOccurrence(
		fileOrPath: TFile | string | null | undefined,
		nodeId: string,
		targetId?: string,
	): Promise<boolean> {
		const activeFile = this.resolveReferenceFile(fileOrPath);
		if (!(activeFile instanceof TFile)) return false;
		const items = await this.getDiscourseNodeSidebarItemsForFile(activeFile);
		const item = items.find((entry) => entry.id === nodeId);
		if (!item || item.targets.length === 0) return false;
		let target: DiscourseNodeLocateTarget | undefined;
		if (targetId) {
			target = item.targets.find((entry) => entry.id === targetId);
		} else {
			target = item.targets[0];
		}
		if (!target) return false;
		if (target.kind === 'markdown-node-link') {
			return this.locateMarkdownNodeTarget(activeFile, target);
		}
		if (target.kind === 'base-node-link') {
			return this.locateBaseDiscourseNodeTarget(activeFile, target);
		}
		return this.locateCanvasDiscourseNodeTarget(activeFile, target);
	}

	private getMarkdownLocateLeaf(file: TFile): WorkspaceLeaf | null {
		const leaves = this.app.workspace.getLeavesOfType('markdown');
		const exact = leaves.find((leaf) => this.getLeafFile(leaf)?.path === file.path);
		return exact || leaves[0] || null;
	}

	private async locateMarkdownTarget(file: TFile, target: ReferenceLocateTarget): Promise<boolean> {
		const leaf = this.getMarkdownLocateLeaf(file);
		if (!leaf || !(leaf.view instanceof MarkdownView)) return false;
		const view = leaf.view;
		const editor = view.editor;
		if (!editor || !target.from || !target.to) return false;
		const from = target.from;
		const to = target.to;
		if (this.app.workspace.activeLeaf !== leaf) {
			await this.app.workspace.setActiveLeaf(leaf, { focus: true });
		}
		editor.setSelection(from, to);
		const cm = (editor as unknown as { cm?: { scrollIntoView?: (range: unknown, margin?: number) => void; focus?: () => void } }).cm;
		cm?.focus?.();
		cm?.scrollIntoView?.({ from, to }, 80);
		if (this._markdownLocateFlashTimer != null) {
			window.clearTimeout(this._markdownLocateFlashTimer);
			this._markdownLocateFlashTimer = null;
		}
		this._markdownLocateFlashTimer = window.setTimeout(() => {
			this._markdownLocateFlashTimer = null;
			if (this.getLeafFile(leaf)?.path !== file.path) return;
			if (!(leaf.view instanceof MarkdownView)) return;
			leaf.view.editor.setSelection(to, to);
			leaf.view.editor.setCursor(to);
		}, 720);
		return true;
	}

	private async locateBaseDomTarget(file: TFile, target: ReferenceLocateTarget): Promise<boolean> {
		const context = this.getBaseLeafAndRootForFile(file.path);
		if (!context) return false;
		const resolveElement = () => {
			let element: HTMLElement | null = null;
			if (target.domKind === 'canvas-node' && target.domId) {
				element = context.root.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(target.domId)}"], .canvas-node[data-node-id="${CSS.escape(target.domId)}"]`);
			}
			if (element instanceof HTMLElement) return element;
			const matches: HTMLElement[] = [];
			for (const candidate of this.getBaseLocateCandidateElements(context.root, file)) {
				if (this.isIgnoredBaseHoverElement(candidate)) continue;
				if (file.extension === 'base' && target.notePath) {
					const linkedNodeId = this.resolveDiscourseNodeIdFromElement(candidate, file.path);
					if (linkedNodeId === target.notePath) {
						return candidate;
					}
				}
				const text = this.normalizeHoverText(candidate.innerText || candidate.textContent || '');
				if (!text) continue;
				const mentions = citationsInText(text).filter((item) => this.canonicalCitekey(item) === this.canonicalCitekey(target.citekey));
				if (mentions.length > 0) {
					matches.push(candidate);
				}
			}
			return matches[target.order] || matches[0] || null;
		};
		let element: HTMLElement | null = resolveElement();
		if (!(element instanceof HTMLElement) && this.app.workspace.activeLeaf !== context.leaf) {
			await this.app.workspace.setActiveLeaf(context.leaf, { focus: true });
			element = await this.waitForBaseLocateElement(context, resolveElement);
		}
		if (!(element instanceof HTMLElement)) return false;
		if (this.app.workspace.activeLeaf !== context.leaf) {
			await this.app.workspace.setActiveLeaf(context.leaf, { focus: true });
		}
		const owner = target.domKind === 'canvas-node'
			? (element.closest<HTMLElement>('[data-node-id], .canvas-node') || element)
			: (this.getBaseInteractionOwner(element, context.root) || element);
		this.setBaseSelectionAnchor(file.path, [target.citekey], []);
		owner.scrollIntoView({ block: 'center', behavior: 'smooth' });
		owner.classList.add('zotsidian-base-locate-flash');
		window.setTimeout(() => owner?.classList.remove('zotsidian-base-locate-flash'), 900);
		if (target.domKind === 'canvas-node' && typeof owner.click === 'function') {
			owner.click();
		}
		if (typeof owner.focus === 'function') {
			owner.focus();
		}
		return true;
	}

	private async locateDiscourseTarget(file: TFile, target: ReferenceLocateTarget): Promise<boolean> {
		const canvasInfo = this.getDiscourseCanvasLeafAndFileForPath(file.path);
		if (!canvasInfo || canvasInfo.file.path !== file.path || !target.shapeId) return false;
		this._discourseLocateSuppressUntil = Date.now() + 2200;

		if (this.app.workspace.activeLeaf !== canvasInfo.leaf) {
			await this.app.workspace.setActiveLeaf(canvasInfo.leaf, { focus: true });
			await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
		}

		const rendered = getRenderedDiscourseShapeElement(canvasInfo.root, target.shapeId);
		const model = await this.getDiscourseCanvasModel(file);
		const waitFrames = async (count: number = 1) => {
			for (let index = 0; index < count; index += 1) {
				await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
			}
		};

		if (this.applyDiscourseLocateState(canvasInfo.leaf, canvasInfo.root, target, model)) {
			await waitFrames(3);
		}

		void rendered;
		const nextCitekeys = target.allCitekeys && target.allCitekeys.length > 1 ? target.allCitekeys : [target.citekey];
		await this.setSidebarSelectedContext(
			{
				kind: nextCitekeys.length > 1 ? 'multi' : target.kind === 'canvas-node' ? 'node' : 'text',
				citekeys: nextCitekeys,
				source: 'canvas-selection',
			},
			file.path
		);
		return true;
	}

	async locateReferenceOccurrence(
		fileOrPath: TFile | string | null | undefined,
		citekey: string,
		targetId?: string
	): Promise<boolean> {
		const activeFile = this.resolveReferenceFile(fileOrPath);
		if (!(activeFile instanceof TFile)) return false;
		const targets = await this.getReferenceLocateTargetsForFile(activeFile, citekey);
		if (targets.length === 0) return false;
		let target: ReferenceLocateTarget | undefined;
		if (targetId) {
			target = targets.find((item) => item.id === targetId);
			if (!target) return false;
		} else {
			const cycleKey = this.getReferenceLocateCycleKey(activeFile.path, citekey);
			const nextIndex = (this._referenceLocateCycleByKey.get(cycleKey) || 0) % targets.length;
			this._referenceLocateCycleByKey.set(cycleKey, nextIndex + 1);
			target = targets[nextIndex];
		}
		if (!target) return false;
		if (target.kind === 'markdown') {
			return this.locateMarkdownTarget(activeFile, target);
		}
		if (target.kind === 'base-dom') {
			return this.locateBaseDomTarget(activeFile, target);
		}
		return this.locateDiscourseTarget(activeFile, target);
	}

	async locateNextReferenceOccurrence(fileOrPath: TFile | string | null | undefined, citekey: string): Promise<boolean> {
		return this.locateReferenceOccurrence(fileOrPath, citekey);
	}

	async locateNextReferenceOccurrenceInActiveFile(citekey: string): Promise<boolean> {
		return this.locateNextReferenceOccurrence(this.app.workspace.getActiveFile(), citekey);
	}

	private extractVisibleBaseCitationsFromLeaf(leaf: WorkspaceLeaf | null): string[] {
		const root = this.getBaseViewRoot(leaf);
		if (!(root instanceof HTMLElement)) return [];
		const file = this.getLeafFile(leaf) ?? this.app.workspace.getActiveFile();
		if (this.isDiscourseCanvasLeaf(leaf)) {
			if (file instanceof TFile) {
				const model = this.getCachedDiscourseCanvasModel(file.path);
				if (model) {
					const pageId = getDiscourseCanvasActivePageId(root, model);
					if (pageId) {
						const ordered = model.pageCitekeys.get(pageId) || [];
						this.discourseDebug('visible-citations', {
							filePath: file.path,
							pageId,
							citekeys: this.summarizeCitekeys(ordered),
						});
						if (ordered.length > 0) {
							return [...ordered];
						}
					}
					this.discourseDebug('visible-citations-empty-page', {
						filePath: file.path,
						pageId,
					});
				} else {
					this.discourseDebug('visible-citations-no-model', { filePath: file.path });
				}
			}
		}
		const text = root.innerText || root.textContent || '';
		return citationsInText(text);
	}

	async refreshActiveScopeAndView(forceIndex: boolean = true) {
		const activeFile = this.app.workspace.getActiveFile();
		const cache = activeFile ? this.app.metadataCache.getFileCache(activeFile) : null;
		const scope = this.resolveScopeFromFrontmatter(cache?.frontmatter as Record<string, unknown> | undefined);
		if (forceIndex) {
			try {
				await this.ensureCitationIndex(scope, true);
			} catch (_err) {
				// Let the view render the degraded/offline state instead of throwing.
			}
		}
		await this.refreshSidebarView();
	}

	getVisibleCitationsFromActiveContext(activeFile: TFile | null): string[] | null {
		const leaf = this.app.workspace.activeLeaf ?? this.app.workspace.getMostRecentLeaf();
		if (!(activeFile instanceof TFile)) return null;
		if (!this.isBaseLeaf(leaf)) return null;
		return this.extractVisibleBaseCitationsFromLeaf(leaf);
	}

	async primeVisibleCitationsFromActiveContext(activeFile: TFile | null): Promise<void> {
		const leaf = this.app.workspace.activeLeaf ?? this.app.workspace.getMostRecentLeaf();
		if (!(activeFile instanceof TFile) || !this.isDiscourseCanvasLeaf(leaf)) return;
		await this.getDiscourseCanvasModel(activeFile);
	}

	isActiveDiscourseCanvasLeaf(): boolean {
		const leaf = this.app.workspace.activeLeaf ?? this.app.workspace.getMostRecentLeaf();
		return this.isDiscourseCanvasLeaf(leaf);
	}

	shouldShowDiscourseGraphsCompatibilityHint(): boolean {
		return false;
	}

	private clearBaseViewObserver() {
		if (this._baseViewObserver) {
			this._baseViewObserver.disconnect();
			this._baseViewObserver = null;
		}
		if (this._baseViewRootCleanup) {
			this._baseViewRootCleanup();
			this._baseViewRootCleanup = null;
		}
		if (this._baseViewRefreshTimer != null) {
			window.clearTimeout(this._baseViewRefreshTimer);
			this._baseViewRefreshTimer = null;
		}
		if (this._discourseSelectionSyncTimer != null) {
			window.clearTimeout(this._discourseSelectionSyncTimer);
			this._discourseSelectionSyncTimer = null;
		}
		if (this._discourseStatePollTimer != null) {
			window.clearInterval(this._discourseStatePollTimer);
			this._discourseStatePollTimer = null;
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
			if (!(file instanceof TFile) || !this.isBaseLeaf(leaf)) return;
			await this.refreshSidebarView();
		}, 140);
	}

	private getCanvasLikeLeafAndFile(): { leaf: WorkspaceLeaf; file: TFile; root: HTMLElement } | null {
		const leaf = this.app.workspace.activeLeaf ?? this.app.workspace.getMostRecentLeaf();
		if (!leaf) return null;
		const file = this.getLeafFile(leaf) ?? this.app.workspace.getActiveFile();
		if (!(file instanceof TFile) || !this.isDiscourseCanvasLeaf(leaf)) return null;
		const root = this.getBaseViewRoot(leaf);
		if (!(root instanceof HTMLElement)) return null;
		return { leaf, file, root };
	}

	private getDiscourseCanvasLeafAndFileForPath(filePath: string): { leaf: WorkspaceLeaf; file: TFile; root: HTMLElement } | null {
		if (!filePath) return null;
		const leaves = new Set<WorkspaceLeaf>();
		const activeLeaf = this.app.workspace.activeLeaf;
		const recentLeaf = this.app.workspace.getMostRecentLeaf();
		if (activeLeaf) leaves.add(activeLeaf);
		if (recentLeaf) leaves.add(recentLeaf);
		for (const leaf of this.app.workspace.getLeavesOfType('tldraw-dg-preview')) {
			leaves.add(leaf);
		}
		for (const leaf of leaves) {
			const file = this.getLeafFile(leaf);
			if (!(file instanceof TFile) || file.path !== filePath || !this.isDiscourseCanvasLeaf(leaf)) continue;
			const root = this.getBaseViewRoot(leaf);
			if (!(root instanceof HTMLElement)) continue;
			return { leaf, file, root };
		}
		return null;
	}

	private extractDiscourseCanvasJson(markdown: string): string | null {
		const match = markdown.match(
			/```json !!!_START_OF_TLDRAW_DG_DATA__DO_NOT_CHANGE_THIS_PHRASE_!!!\s*([\s\S]*?)\s*!!!_END_OF_TLDRAW_DG_DATA__DO_NOT_CHANGE_THIS_PHRASE_!!!\s*```/
		);
		if (match?.[1]?.trim()) {
			return match[1].trim();
		}
		const fallback = markdown.match(/```json !!!_START_OF_TLDRAW_DG_DATA__DO_NOT_CHANGE_THIS_PHRASE_!!!\s*([\s\S]*?)\s*```/);
		return fallback?.[1]?.trim() || null;
	}

	private extractCitekeyFromDiscourseNodeTitle(title: string): string | null {
		const text = title.trim();
		if (!text) return null;
		const mentions = citationsInText(text);
		if (mentions.length > 0) return mentions[0];
		if (text.startsWith('@')) {
			return text.replace(/^@+/, '').trim() || null;
		}
		return null;
	}

	private extractPlainTextFromTldrawRichText(value: unknown): string {
		if (!value) return '';
		if (typeof value === 'string') return value;
		if (Array.isArray(value)) {
			return value.map((entry) => this.extractPlainTextFromTldrawRichText(entry)).join('');
		}
		if (typeof value !== 'object') return '';
		const record = value as Record<string, unknown>;
		const text = typeof record.text === 'string' ? record.text : '';
		const content = Array.isArray(record.content) ? record.content : [];
		const nested = content.map((entry) => this.extractPlainTextFromTldrawRichText(entry)).join('');
		const joiner = record.type === 'paragraph' || record.type === 'hardBreak' ? '\n' : '';
		return `${text}${nested}${joiner}`;
	}

	private estimateDiscourseTextHeight(size: string, text: string): number {
		const normalized = size || 'm';
		const lineHeightMap: Record<string, number> = {
			s: 22,
			m: 30,
			l: 38,
			xl: 52,
		};
		const lineHeight = lineHeightMap[normalized] || 30;
		const lineCount = Math.max(1, text.split(/\r?\n/).length);
		return Math.max(lineHeight + 12, lineCount * lineHeight + 14);
	}

	private getCachedDiscourseCanvasModel(filePath: string): DiscourseCanvasModel | null {
		return this._discourseCanvasNodesByFile.get(filePath) || null;
	}

	private getCachedDiscourseCanvasNodeMap(filePath: string): Map<string, DiscourseCanvasNodeEntry> | null {
		return this.getCachedDiscourseCanvasModel(filePath)?.nodes || null;
	}

	private parseDiscourseCanvasRecords(records: Array<Record<string, unknown>>, mtime: number): DiscourseCanvasModel {
		return buildDiscourseCanvasModel(records, mtime, {
			extractCitekeyFromDiscourseNodeTitle: (title) => this.extractCitekeyFromDiscourseNodeTitle(title),
			extractPlainTextFromTldrawRichText: (richText) => this.extractPlainTextFromTldrawRichText(richText),
			normalizeHoverText: (text) => this.normalizeHoverText(text),
			estimateDiscourseTextHeight: (size, text) => this.estimateDiscourseTextHeight(size, text),
		});
	}

	private getDiscourseLocateTargetBounds(
		model: DiscourseCanvasModel | null,
		target: ReferenceLocateTarget,
	): { x: number; y: number; w: number; h: number } | null {
		if (!model || !target.shapeId) return null;
		const node = model.nodes.get(target.shapeId);
		if (node) {
			return { x: node.x, y: node.y, w: node.w, h: node.h };
		}
		const textShape = model.textShapes.find((entry) => entry.shapeId === target.shapeId);
		if (textShape) {
			return { x: textShape.x, y: textShape.y, w: textShape.w, h: textShape.h };
		}
		return null;
	}

	private computeDiscourseLocateCamera(
		root: HTMLElement,
		currentCamera: { x: number; y: number; z: number } | null,
		targetBounds: { x: number; y: number; w: number; h: number } | null,
	): { x: number; y: number; z: number } | null {
		if (!targetBounds) return null;
		const viewport = getDiscourseCanvasViewport(root);
		const rect = viewport.getBoundingClientRect();
		if (!rect.width || !rect.height) return null;
		const nextZoom = currentCamera?.z && currentCamera.z > 0 ? currentCamera.z : 1;
		const centerX = targetBounds.x + ((targetBounds.w || 0) / 2);
		const centerY = targetBounds.y + ((targetBounds.h || 0) / 2);
		return {
			x: -centerX + rect.width / (2 * nextZoom),
			y: -centerY + rect.height / (2 * nextZoom),
			z: nextZoom,
		};
	}

	private applyDiscourseLocateState(
		leaf: WorkspaceLeaf | null,
		root: HTMLElement,
		target: ReferenceLocateTarget,
		model: DiscourseCanvasModel | null,
	): boolean {
		const store = getDiscourseViewStore(leaf);
		if (!store || typeof store.put !== 'function') return false;

		const targetPageId = target.pageId || getDiscourseStoreCurrentPageId(leaf) || model?.currentPageId || null;
		const instance = getDiscourseStoreInstanceRecord(leaf);
		const pageState = getDiscourseStorePageStateRecord(leaf, targetPageId);
		if (!instance || !pageState || !targetPageId) return false;

		const nextRecords: Record<string, unknown>[] = [];
		if (instance.currentPageId !== targetPageId) {
			nextRecords.push({ ...instance, currentPageId: targetPageId });
		}

		const selectedShapeIds = [target.shapeId].filter((shapeId): shapeId is string => typeof shapeId === 'string' && !!shapeId);
		const currentSelectedShapeIds = Array.isArray(pageState.selectedShapeIds)
			? pageState.selectedShapeIds.filter((shapeId): shapeId is string => typeof shapeId === 'string')
			: [];
		const sameSelection = currentSelectedShapeIds.length === selectedShapeIds.length
			&& currentSelectedShapeIds.every((shapeId, index) => shapeId === selectedShapeIds[index]);
		if (!sameSelection || pageState.editingShapeId !== null || pageState.hoveredShapeId !== null) {
			nextRecords.push({
				...pageState,
				selectedShapeIds,
				editingShapeId: null,
				hoveredShapeId: null,
			});
		}

		const camera = getDiscourseStoreCameraRecord(leaf, targetPageId);
		const nextCamera = this.computeDiscourseLocateCamera(
			root,
			camera ? {
				x: typeof camera.x === 'number' ? camera.x : 0,
				y: typeof camera.y === 'number' ? camera.y : 0,
				z: typeof camera.z === 'number' && camera.z > 0 ? camera.z : 1,
			} : null,
			this.getDiscourseLocateTargetBounds(model, target),
		);
		if (camera && nextCamera) {
			const cameraChanged =
				Math.abs((typeof camera.x === 'number' ? camera.x : 0) - nextCamera.x) > 0.5
				|| Math.abs((typeof camera.y === 'number' ? camera.y : 0) - nextCamera.y) > 0.5
				|| Math.abs((typeof camera.z === 'number' ? camera.z : 1) - nextCamera.z) > 0.01;
			if (cameraChanged) {
				nextRecords.push({
					...camera,
					x: nextCamera.x,
					y: nextCamera.y,
					z: nextCamera.z,
				});
			}
		}

		if (nextRecords.length === 0) return true;
		try {
			if (typeof store.atomic === 'function') {
				store.atomic(() => {
					store.put?.(nextRecords);
				});
			} else {
				store.put(nextRecords);
			}
			return true;
		} catch {
			return false;
		}
	}

	private resolveSelectedDiscourseContextFromStore(
		leaf: WorkspaceLeaf | null,
		filePath: string,
	): Omit<SidebarSelectedContext, 'filePath'> | null {
		const model = this.getCachedDiscourseCanvasModel(filePath);
		if (!model) return null;
		const selectedShapeIds = getDiscourseStoreSelectedShapeIds(leaf);
		const currentPageId = getDiscourseStoreCurrentPageId(leaf) || model.currentPageId;
		const selected = resolveSelectedDiscourseContextFromModel(model, selectedShapeIds, currentPageId, {
			normalizeCitekeys: (citekeys) => this.normalizeSidebarSelectedCitekeys(citekeys),
		});
		if (!selected) return null;
		return {
			kind: selected.kind,
			citekeys: selected.citekeys,
			source: 'canvas-selection',
		};
	}

	private async resolveSelectedDiscourseNodeIdsFromStore(leaf: WorkspaceLeaf | null, filePath: string): Promise<string[]> {
		const model = this.getCachedDiscourseCanvasModel(filePath);
		if (!model) return [];
		const selectedShapeIds = getDiscourseStoreSelectedShapeIds(leaf);
		if (selectedShapeIds.length === 0) return [];
		const file = this.resolveReferenceFile(filePath);
		if (!(file instanceof TFile)) return [];
		const currentPageId = getDiscourseStoreCurrentPageId(leaf) || model.currentPageId;
		const shapeIds = currentPageId
			? selectedShapeIds.filter((shapeId) => model.nodes.get(shapeId)?.pageId === currentPageId)
			: selectedShapeIds;
		const nodeIds: string[] = [];
		for (const shapeId of shapeIds) {
			const node = model.nodes.get(shapeId);
			if (!node?.nodeTypeId || !this.shouldShowDiscourseNodeType(node.nodeTypeId)) continue;
			const linkedFile =
				(node.src ? await this.resolveDiscourseNodeFileFromSrc(file, node.src) : null)
				|| this.resolveDiscourseNodeFileFromTitle(node.title || '', file.path);
			nodeIds.push(linkedFile?.path || `${file.path}::${node.shapeId}`);
		}
		return Array.from(new Set(nodeIds.filter(Boolean)));
	}

	private resolveSelectedDiscourseSourceNodeFromStore(leaf: WorkspaceLeaf | null, filePath: string): string | null {
		const model = this.getCachedDiscourseCanvasModel(filePath);
		if (!model) return null;
		const selectedShapeIds = getDiscourseStoreSelectedShapeIds(leaf);
		const currentPageId = getDiscourseStoreCurrentPageId(leaf) || model.currentPageId;
		return resolveSelectedDiscourseSourceCitekeyFromModel(model, selectedShapeIds, currentPageId);
	}

	private resolveHoveredDiscourseTextFromStore(
		leaf: WorkspaceLeaf | null,
		filePath: string,
		root: HTMLElement,
	): { citekey: string; element: HTMLElement | null } | null {
		const hoveredShapeId = getDiscourseStoreHoveredShapeId(leaf);
		if (!hoveredShapeId) return null;
		const model = this.getCachedDiscourseCanvasModel(filePath);
		if (!model) return null;
		const hovered = resolveHoveredDiscoursePrimaryCitekeyFromModel(model, hoveredShapeId);
		if (!hovered) return null;
		return {
			citekey: hovered.citekey,
			element: getRenderedDiscourseShapeElement(root, hovered.shapeId),
		};
	}

	private async getDiscourseCanvasModel(file: TFile): Promise<DiscourseCanvasModel> {
		const liveCanvas = this.getDiscourseCanvasLeafAndFileForPath(file.path);
		if (liveCanvas?.file.path === file.path) {
			const liveRecords = getDiscourseStoreRecords(liveCanvas.leaf);
			if (liveRecords.length > 0) {
				const liveModel = this.parseDiscourseCanvasRecords(liveRecords, Date.now());
				this._discourseCanvasNodesByFile.set(file.path, liveModel);
				return liveModel;
			}
		}
		const cached = this._discourseCanvasNodesByFile.get(file.path);
		if (cached && cached.mtime === file.stat.mtime) {
			return cached;
		}
		try {
			const markdown = await this.app.vault.cachedRead(file);
			const payload = this.extractDiscourseCanvasJson(markdown);
			if (!payload) {
				const emptyModel = this.parseDiscourseCanvasRecords([], file.stat.mtime);
				this._discourseCanvasNodesByFile.set(file.path, emptyModel);
				return emptyModel;
			}

			const parsed = JSON.parse(payload) as {
				raw?: { records?: Array<Record<string, unknown>> };
			};
			const rawRecords = parsed?.raw?.records;
			const records = Array.isArray(rawRecords)
				? rawRecords.filter((record): record is Record<string, unknown> => !!record && typeof record === 'object')
				: [];
			const model = this.parseDiscourseCanvasRecords(records, file.stat.mtime);
			this._discourseCanvasNodesByFile.set(file.path, model);
			return model;
		} catch (_err) {
			// Keep compatibility mode best-effort.
		}
		const model = this.parseDiscourseCanvasRecords([], file.stat.mtime);
		this._discourseCanvasNodesByFile.set(file.path, model);
		return model;
	}

	private async getDiscourseCanvasNodeMap(file: TFile): Promise<Map<string, DiscourseCanvasNodeEntry>> {
		const model = await this.getDiscourseCanvasModel(file);
		return model.nodes;
	}

	private async getDiscourseCanvasGeometryHit(
		file: TFile,
		root: HTMLElement,
		clientX: number,
		clientY: number
	): Promise<{ citekey: string; element: HTMLElement | null; kind: 'node' | 'text' } | null> {
		const model = await this.getDiscourseCanvasModel(file);
		return getDiscourseCanvasGeometryHitFromModel(root, model, clientX, clientY, {
			pointInRect: (x, y, rect) => this.pointInRect(x, y, rect),
		});
	}

	private getCachedDiscourseCanvasGeometryHit(
		filePath: string,
		root: HTMLElement,
		clientX: number,
		clientY: number
	): { citekey: string; element: HTMLElement | null; kind: 'node' | 'text' } | null {
		const model = this.getCachedDiscourseCanvasModel(filePath);
		if (!model) return null;
		return getDiscourseCanvasGeometryHitFromModel(root, model, clientX, clientY, {
			pointInRect: (x, y, rect) => this.pointInRect(x, y, rect),
		});
	}

	private getDiscourseCanvasShapeIdFromEvent(event: MouseEvent, root: HTMLElement): string | null {
		const collectShapeId = (element: HTMLElement | null): string | null => {
			if (!(element instanceof HTMLElement)) return null;
			const shape = element.closest<HTMLElement>('.tl-shape[data-shape-id], [data-shape-id^="shape:"]');
			if (!(shape instanceof HTMLElement)) return null;
			if (!root.contains(shape)) return null;
			return shape.getAttribute('data-shape-id') || null;
		};

		const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
		for (const node of path) {
			if (!(node instanceof HTMLElement)) continue;
			const shapeId = collectShapeId(node);
			if (shapeId) return shapeId;
		}

		const stack = typeof document.elementsFromPoint === 'function'
			? document.elementsFromPoint(event.clientX, event.clientY)
			: [document.elementFromPoint(event.clientX, event.clientY)].filter(Boolean) as Element[];
		for (const candidate of stack) {
			if (!(candidate instanceof HTMLElement)) continue;
			const shapeId = collectShapeId(candidate);
			if (shapeId) return shapeId;
		}

		return null;
	}

	private getDiscourseCanvasShapeIdByHitTest(
		root: HTMLElement,
		nodeMap: Map<string, DiscourseCanvasNodeEntry>,
		clientX: number,
		clientY: number
	): string | null {
		const candidates = Array.from(root.querySelectorAll<HTMLElement>('.tl-shape[data-shape-id], [data-shape-id^="shape:"]'))
			.map((element) => {
				const shapeId = element.getAttribute('data-shape-id') || '';
				if (!shapeId || !nodeMap.has(shapeId)) return null;
				const rect = element.getBoundingClientRect();
				if (!this.pointInRect(clientX, clientY, rect)) return null;
				const area = Math.max(1, rect.width * rect.height);
				const cx = rect.left + rect.width / 2;
				const cy = rect.top + rect.height / 2;
				return {
					shapeId,
					area,
					distance: Math.hypot(clientX - cx, clientY - cy),
				};
			})
			.filter((entry): entry is { shapeId: string; area: number; distance: number } => !!entry);
		candidates.sort((a, b) => a.area - b.area || a.distance - b.distance);
		return candidates[0]?.shapeId || null;
	}

	private findVisibleCitationGeometryHit(root: HTMLElement, clientX: number, clientY: number): string | null {
		const candidates = Array.from(root.querySelectorAll<HTMLElement>('*'))
			.map((element) => {
				if (this.isIgnoredBaseHoverElement(element)) return null;
				const citekey = this.extractStandaloneCitationFromElement(element)?.replace(/^@+/, '').trim() || '';
				if (!citekey) return null;
				const rect = element.getBoundingClientRect();
				if (rect.width < 6 || rect.height < 6) return null;
				const margin = 36;
				const near =
					clientX >= rect.left - margin &&
					clientX <= rect.right + margin &&
					clientY >= rect.top - margin &&
					clientY <= rect.bottom + margin;
				if (!near) return null;
				const cx = rect.left + rect.width / 2;
				const cy = rect.top + rect.height / 2;
				const containsPoint = this.pointInRect(clientX, clientY, rect);
				return {
					citekey,
					containsPoint,
					area: Math.max(1, rect.width * rect.height),
					distance: Math.hypot(clientX - cx, clientY - cy),
				};
			})
			.filter((entry): entry is { citekey: string; containsPoint: boolean; area: number; distance: number } => !!entry);
		if (candidates.length === 0) return null;
		candidates.sort((a, b) => {
			if (a.containsPoint !== b.containsPoint) return a.containsPoint ? -1 : 1;
			return a.distance - b.distance || a.area - b.area;
		});
		return candidates[0]?.citekey || null;
	}

	private async resolveDiscourseCanvasClickedCitekey(file: TFile, event: MouseEvent, root: HTMLElement): Promise<string | null> {
		const geometryHit = await this.getDiscourseCanvasGeometryHit(file, root, event.clientX, event.clientY);
		if (geometryHit?.citekey) {
			const normalized = geometryHit.citekey.replace(/^@+/, '').trim() || null;
			this.discourseDebug('click-hit-geometry', {
				filePath: file.path,
				clientX: event.clientX,
				clientY: event.clientY,
				kind: geometryHit.kind,
				citekey: normalized,
			});
			return normalized;
		}
		const nodeMap = await this.getDiscourseCanvasNodeMap(file);
		let shapeId = this.getDiscourseCanvasShapeIdFromEvent(event, root);
		if (!shapeId || !nodeMap.has(shapeId)) {
			shapeId = this.getDiscourseCanvasShapeIdByHitTest(root, nodeMap, event.clientX, event.clientY);
		}
		if (shapeId) {
			const entry = nodeMap.get(shapeId);
			const citekey = entry?.citekey?.replace(/^@+/, '').trim() || '';
			if (citekey) {
				this.discourseDebug('click-hit-shape', {
					filePath: file.path,
					clientX: event.clientX,
					clientY: event.clientY,
					shapeId,
					citekey,
				});
				return citekey;
			}
		}
		const fallback = this.findVisibleCitationGeometryHit(root, event.clientX, event.clientY);
		this.discourseDebug('click-hit-fallback', {
			filePath: file.path,
			clientX: event.clientX,
			clientY: event.clientY,
			citekey: fallback,
		});
		return fallback;
	}

	private async handleDiscourseCanvasRootClick(
		event: MouseEvent,
		leaf: WorkspaceLeaf | null,
		file: TFile,
		root: HTMLElement
	) {
		if (!this.settings.enableDiscourseGraphsCompatibility) return;
		const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
		const target = path.find((node): node is HTMLElement => node instanceof HTMLElement)
			|| (event.target instanceof HTMLElement ? event.target : null);
		this.discourseDebug('root-click-received', {
			filePath: file.path,
			clientX: event.clientX,
			clientY: event.clientY,
			target: this.summarizeDiscourseTarget(target),
		});
		if (!(target instanceof HTMLElement)) return;
		if (this._baseHoverCardEl?.contains(target)) return;
		if (!root.contains(target) && !path.includes(root)) return;
		if (this.isIgnoredBaseHoverElement(target)) return;

		const filePath = file.path;
		this.hideBaseHoverCard();
		this._suppressBaseHoverUntil = Date.now() + 450;

		const clickedFocused = await this.resolveDiscourseCanvasClickedCitekey(file, event, root);
		this._lastCanvasClickContext = {
			filePath,
			x: event.clientX,
			y: event.clientY,
			at: Date.now(),
			candidate: clickedFocused,
		};
		this.discourseDebug('root-click-resolved', {
			filePath,
			candidate: clickedFocused,
		});
		this.scheduleDiscourseSelectionSync(leaf, filePath, 80);
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
		this._baseHoverRootEl = null;
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

	private normalizeHoverText(value: string): string {
		return value
			.replace(/\u200b/g, '')
			.replace(/\s+/g, ' ')
			.trim();
	}

	private isIgnoredBaseHoverElement(element: HTMLElement): boolean {
		const ignoredAncestor = element.closest([
			'.zotsidian-base-hover-card',
			'.canvas-controls',
			'.canvas-control-item',
			'.canvas-node-menu',
			'.canvas-card-menu',
			'.canvas-zoom-actions',
			'.view-header',
			'.workspace-tab-header',
			'.menu',
			'.tooltip',
			'.popover'
		].join(', '));
		if (ignoredAncestor) return true;

		const controlCandidate = element.closest('button, [title], [aria-label], .clickable-icon');
		if (!(controlCandidate instanceof HTMLElement)) return false;
		const marker = [
			controlCandidate.getAttribute('aria-label') || '',
			controlCandidate.getAttribute('title') || '',
			controlCandidate.innerText || '',
			controlCandidate.className || '',
		].join(' ').toLowerCase();
		return /(zoom|selection|delete|duplicate|settings|palette|color|undo|redo|reset|fit view|help|toolbar|control)/.test(marker);
	}

	private extractStandaloneCitationFromElement(element: HTMLElement): string | null {
		const candidates = [
			element.getAttribute('data-citekey') || '',
			element.getAttribute('aria-label') || '',
			element.getAttribute('title') || '',
			element.innerText || element.textContent || '',
		];
		for (const candidate of candidates) {
			const text = this.normalizeHoverText(candidate);
			if (!text || text.length > 140) continue;
			const mentions = citationsInText(text);
			if (mentions.length !== 1) continue;
			const citekey = mentions[0];
			const escaped = citekey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
			const normalizedCompact = text.replace(/\s+/g, '');
			const exactForms = [
				new RegExp(`^\\[@${escaped}\\]$`, 'i'),
				new RegExp(`^@${escaped}$`, 'i'),
				new RegExp(`^\\[\\[@${escaped}\\]\\]$`, 'i'),
			];
			if (exactForms.some((pattern) => pattern.test(normalizedCompact))) {
				return citekey;
			}
			if (normalizedCompact.includes(`@${citekey}`) && normalizedCompact.length <= (`@${citekey}`.length + 18)) {
				return citekey;
			}
		}
		return null;
	}

	private extractStandaloneWikiLinkFromElement(element: HTMLElement): string | null {
		const candidates = [
			element.getAttribute('data-href') || '',
			element.getAttribute('aria-label') || '',
			element.getAttribute('title') || '',
			element.innerText || element.textContent || '',
		];
		for (const candidate of candidates) {
			const text = this.normalizeHoverText(candidate);
			if (!text || text.length > 220) continue;
			const mentions = this.extractMarkdownWikiLinkMentions(text);
			if (mentions.length !== 1) continue;
			const mention = mentions[0];
			const normalized = text.replace(/\s+/g, '');
			const exact = `[[${mention.rawLink.replace(/\s+/g, '')}]]`;
			if (normalized === exact || normalized.includes(exact)) {
				return mention.rawLink;
			}
		}
		return null;
	}

	private resolveDiscourseNodeIdFromElement(element: HTMLElement, sourcePath: string): string | null {
		const directHref = element.getAttribute('data-href')
			|| element.closest<HTMLElement>('[data-href], a.internal-link')?.getAttribute('data-href')
			|| '';
		const rawLink = directHref || this.extractStandaloneWikiLinkFromElement(element) || '';
		if (!rawLink) return null;
		const linkedFile = this.resolveWikiLinkToFile(rawLink, sourcePath);
		const nodeTypeId = this.getDiscourseNodeTypeIdForFile(linkedFile);
		if (!linkedFile || !nodeTypeId || !this.shouldShowDiscourseNodeType(nodeTypeId)) return null;
		return linkedFile.path;
	}

	private findStandaloneCitationInNearbySubtree(
		element: HTMLElement,
		maxDepth: number = 3,
		maxNodes: number = 18
	): { element: HTMLElement; citekey: string } | null {
		const queue: Array<{ element: HTMLElement; depth: number }> = [{ element, depth: 0 }];
		let inspected = 0;

		while (queue.length > 0 && inspected < maxNodes) {
			const current = queue.shift();
			if (!current) break;
			const { element: candidate, depth } = current;
			if (candidate !== element) {
				inspected += 1;
				if (!this.isIgnoredBaseHoverElement(candidate)) {
					const citekey = this.extractStandaloneCitationFromElement(candidate);
					if (citekey) {
						return { element: candidate, citekey };
					}
				}
			}
			if (depth >= maxDepth) continue;
			for (const child of Array.from(candidate.children)) {
				if (!(child instanceof HTMLElement)) continue;
				queue.push({ element: child, depth: depth + 1 });
				if (queue.length >= maxNodes * 2) break;
			}
		}

		return null;
	}

	private findBaseHoverTarget(start: HTMLElement, root: HTMLElement): { element: HTMLElement; citekey: string } | null {
		let current: HTMLElement | null = start;
		let depth = 0;
		while (current) {
			if (current === root.parentElement) break;
			if (this.isIgnoredBaseHoverElement(current)) return null;
			const citekey = this.extractStandaloneCitationFromElement(current);
			if (citekey) return { element: current, citekey };
			if (depth < 3 && current !== root) {
				const subtreeMatch = this.findStandaloneCitationInNearbySubtree(current);
				if (subtreeMatch) return subtreeMatch;
			}
			if (current === root) break;
			current = current.parentElement;
			depth += 1;
		}
		return null;
	}

	private findBaseHoverTargetFromPoint(clientX: number, clientY: number, root: HTMLElement): { element: HTMLElement; citekey: string } | null {
		const stack = typeof document.elementsFromPoint === 'function'
			? document.elementsFromPoint(clientX, clientY)
			: [document.elementFromPoint(clientX, clientY)].filter(Boolean) as Element[];
		for (const candidate of stack) {
			if (!(candidate instanceof HTMLElement)) continue;
			if (!root.contains(candidate)) continue;
			if (this.isIgnoredBaseHoverElement(candidate)) continue;
			const target = this.findBaseHoverTarget(candidate, root);
			if (target) return target;
		}
		return null;
	}

	private getBaseLocateCandidateElements(root: HTMLElement, file: TFile): HTMLElement[] {
		if (file.extension === 'canvas') {
			const nodes = Array.from(root.querySelectorAll<HTMLElement>('[data-node-id], .canvas-node'));
			if (nodes.length > 0) return nodes;
		}
		const cellCandidates = Array.from(root.querySelectorAll<HTMLElement>('[role="gridcell"], td, .table-cell-wrapper, .table-cell, .view-content a, .internal-link'));
		return cellCandidates.length > 0 ? cellCandidates : Array.from(root.querySelectorAll<HTMLElement>('*'));
	}

	private getBaseSelectionElements(root: HTMLElement): HTMLElement[] {
		const selected = new Set<HTMLElement>();
		const active = document.activeElement;
		if (active instanceof HTMLElement && root.contains(active)) {
			const owner = active.closest<HTMLElement>('[role="gridcell"], td, .table-cell-wrapper, .table-cell, [data-node-id], .canvas-node');
			if (owner) selected.add(owner);
		}
		for (const element of Array.from(root.querySelectorAll<HTMLElement>('[aria-selected="true"], .is-selected, .selected, .mod-selected, .is-focused, .canvas-node.is-focused, .canvas-node.mod-selected'))) {
			selected.add(element);
		}
		return Array.from(selected);
	}

	private getBaseSelectedCitekeys(root: HTMLElement): string[] {
		const citekeys: string[] = [];
		for (const element of this.getBaseSelectionElements(root)) {
			const exact = this.extractStandaloneCitationFromElement(element);
			const nearby = exact ? null : this.findStandaloneCitationInNearbySubtree(element, 5, 28);
			const citekey = (exact || nearby?.citekey || '').replace(/^@+/, '').trim();
			if (citekey) citekeys.push(citekey);
		}
		return this.normalizeSidebarSelectedCitekeys(citekeys);
	}

	private getBaseSelectedDiscourseNodeIds(root: HTMLElement, file: TFile): string[] {
		const nodeIds: string[] = [];
		for (const element of this.getBaseSelectionElements(root)) {
			const nodeId = this.resolveDiscourseNodeIdFromElement(element, file.path);
			if (nodeId) nodeIds.push(nodeId);
		}
		return Array.from(new Set(nodeIds));
	}

	private findDiscourseSourceNodeCitekeyFromPoint(clientX: number, clientY: number, root: HTMLElement): string | null {
		const hoverTarget = this.findBaseHoverTargetFromPoint(clientX, clientY, root);
		if (!hoverTarget) return null;
		const citekey = hoverTarget.citekey.replace(/^@+/, '').trim();
		if (!citekey) return null;
		if (!this.findSourceNoteFile(citekey)) return null;
		return citekey;
	}

	private findDiscourseSourceNodeCitekeyFromEventPath(path: EventTarget[], root: HTMLElement): string | null {
		for (const node of path) {
			if (!(node instanceof HTMLElement)) continue;
			if (!root.contains(node)) continue;
			const direct = this.extractStandaloneCitationFromElement(node);
			if (direct && this.findSourceNoteFile(direct.replace(/^@+/, '').trim())) {
				return direct.replace(/^@+/, '').trim();
			}
			const nearby = this.findStandaloneCitationInNearbySubtree(node, 8, 120);
			if (nearby?.citekey && this.findSourceNoteFile(nearby.citekey.replace(/^@+/, '').trim())) {
				return nearby.citekey.replace(/^@+/, '').trim();
			}
		}
		return null;
	}

	private pointInRect(x: number, y: number, rect: DOMRect): boolean {
		return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
	}

	private findSelectedDiscourseSourceNodeCitekey(root: HTMLElement, clientX: number, clientY: number): string | null {
		const selectors = [
			'[aria-selected="true"]',
			'.is-selected',
			'.selected',
			'.mod-selected',
			'.canvas-node.is-focused',
			'.canvas-node.is-selected',
			'.canvas-node.mod-selected',
		];
		const candidates = Array.from(root.querySelectorAll<HTMLElement>(selectors.join(', ')));
		if (candidates.length === 0) return null;
		const ranked = candidates
			.map((element) => {
				const exact = this.extractStandaloneCitationFromElement(element);
				const nearby = exact ? null : this.findStandaloneCitationInNearbySubtree(element, 8, 120);
				const citekey = (exact || nearby?.citekey || '').replace(/^@+/, '').trim();
				if (!citekey || !this.findSourceNoteFile(citekey)) return null;
				const rect = element.getBoundingClientRect();
				const cx = rect.left + rect.width / 2;
				const cy = rect.top + rect.height / 2;
				const distance = Math.hypot(clientX - cx, clientY - cy);
				return { citekey, distance, containsPoint: this.pointInRect(clientX, clientY, rect) };
			})
			.filter((entry): entry is { citekey: string; distance: number; containsPoint: boolean } => !!entry);
		const containsPoint = ranked.filter((entry) => entry.containsPoint);
		const pool = containsPoint.length > 0 ? containsPoint : ranked;
		pool.sort((a, b) => a.distance - b.distance);
		return pool[0]?.citekey || null;
	}

	private getSelectedDiscourseSourceNodeCandidates(root: HTMLElement): Array<{ citekey: string; rect: DOMRect }> {
		const selectors = [
			'[aria-selected="true"]',
			'.is-selected',
			'.selected',
			'.mod-selected',
			'.canvas-node.is-focused',
			'.canvas-node.is-selected',
			'.canvas-node.mod-selected',
		];
		return Array.from(root.querySelectorAll<HTMLElement>(selectors.join(', ')))
			.map((element) => {
				const exact = this.extractStandaloneCitationFromElement(element);
				const nearby = exact ? null : this.findStandaloneCitationInNearbySubtree(element, 8, 120);
				const citekey = (exact || nearby?.citekey || '').replace(/^@+/, '').trim();
				if (!citekey || !this.findSourceNoteFile(citekey)) return null;
				return { citekey, rect: element.getBoundingClientRect() };
			})
			.filter((entry): entry is { citekey: string; rect: DOMRect } => !!entry);
	}

	private getDiscourseSelectionForegroundRect(root: HTMLElement): DOMRect | null {
		const selection = root.querySelector<SVGElement | HTMLElement>('.tl-selection__fg, [data-testid="selection-foreground"]');
		if (!(selection instanceof SVGElement || selection instanceof HTMLElement)) return null;
		const rect = selection.getBoundingClientRect();
		if (rect.width <= 0 || rect.height <= 0) return null;
		return rect;
	}

	private getRectIntersectionArea(a: DOMRect, b: DOMRect): number {
		const left = Math.max(a.left, b.left);
		const right = Math.min(a.right, b.right);
		const top = Math.max(a.top, b.top);
		const bottom = Math.min(a.bottom, b.bottom);
		return Math.max(0, right - left) * Math.max(0, bottom - top);
	}

	private resolveSelectedDiscourseSourceNodeFromSelectionBox(root: HTMLElement, filePath: string): string | null {
		const model = this.getCachedDiscourseCanvasModel(filePath);
		if (!model) return null;
		const pageId = getDiscourseCanvasActivePageId(root, model);
		if (!pageId) return null;
		const selectionRect = this.getDiscourseSelectionForegroundRect(root);
		if (!selectionRect) return null;

		const hits = Array.from(model.nodes.values())
			.filter((entry) => entry.pageId === pageId && !!entry.citekey)
			.map((entry) => {
				const element = getRenderedDiscourseShapeElement(root, entry.shapeId);
				if (!(element instanceof HTMLElement)) return null;
				const rect = element.getBoundingClientRect();
				if (rect.width <= 0 || rect.height <= 0) return null;
				const intersection = this.getRectIntersectionArea(selectionRect, rect);
				if (intersection <= 0) return null;
				const selectionCx = selectionRect.left + selectionRect.width / 2;
				const selectionCy = selectionRect.top + selectionRect.height / 2;
				const rectCx = rect.left + rect.width / 2;
				const rectCy = rect.top + rect.height / 2;
				return {
					citekey: entry.citekey!,
					intersection,
					distance: Math.hypot(selectionCx - rectCx, selectionCy - rectCy),
					areaDelta: Math.abs(selectionRect.width * selectionRect.height - rect.width * rect.height),
				};
			})
			.filter((entry): entry is { citekey: string; intersection: number; distance: number; areaDelta: number } => !!entry);

		if (hits.length === 0) return null;
		hits.sort((a, b) => {
			if (a.intersection !== b.intersection) return b.intersection - a.intersection;
			if (a.distance !== b.distance) return a.distance - b.distance;
			return a.areaDelta - b.areaDelta;
		});
		return hits[0]?.citekey || null;
	}

	private resolveSelectedDiscourseSourceNodeCitekey(root: HTMLElement, filePath: string): string | null {
		const activeLeaf = this.app.workspace.activeLeaf ?? this.app.workspace.getMostRecentLeaf();
		return this.resolveSelectedDiscourseSourceNodeCitekeyForLeaf(root, filePath, activeLeaf);
	}

	private resolveSelectedDiscourseSourceNodeCitekeyForLeaf(
		root: HTMLElement,
		filePath: string,
		leaf: WorkspaceLeaf | null,
	): string | null {
		const byStore = this.resolveSelectedDiscourseSourceNodeFromStore(leaf, filePath);
		if (byStore) return byStore;
		const bySelectionBox = this.resolveSelectedDiscourseSourceNodeFromSelectionBox(root, filePath);
		if (bySelectionBox) return bySelectionBox;
		const candidates = this.getSelectedDiscourseSourceNodeCandidates(root);
		if (candidates.length === 0) return null;
		return candidates[0]?.citekey || null;
	}

	private resolveSelectedDiscourseContextForLeaf(
		root: HTMLElement,
		filePath: string,
		leaf: WorkspaceLeaf | null,
	): Omit<SidebarSelectedContext, 'filePath'> | null {
		const byStore = this.resolveSelectedDiscourseContextFromStore(leaf, filePath);
		if (byStore) return byStore;
		const bySelectionBox = this.resolveSelectedDiscourseSourceNodeFromSelectionBox(root, filePath);
		if (bySelectionBox) {
			return {
				kind: 'node',
				citekeys: [bySelectionBox],
				source: 'canvas-selection',
			};
		}
		const candidates = this.getSelectedDiscourseSourceNodeCandidates(root);
		if (candidates.length === 0) return null;
		return {
			kind: 'node',
			citekeys: [candidates[0].citekey],
			source: 'canvas-selection',
		};
	}

	private isSourceNodeLikeHoverTarget(target: { element: HTMLElement; citekey: string } | null): boolean {
		if (!target) return false;
		if (!this.findSourceNoteFile(target.citekey)) return false;
		const leaf = this.app.workspace.activeLeaf ?? this.app.workspace.getMostRecentLeaf();
		if (!this.isDiscourseCanvasLeaf(leaf)) return false;
		const file = this.getLeafFile(leaf) ?? this.app.workspace.getActiveFile();
		if (!(file instanceof TFile)) return false;
		const discourseShape = target.element.closest<HTMLElement>('.tl-shape[data-shape-id], [data-shape-id^="shape:"]');
		const shapeId = discourseShape?.getAttribute('data-shape-id') || '';
		if (!shapeId) return false;
		const nodeMap = this.getCachedDiscourseCanvasNodeMap(file.path);
		return !!nodeMap?.has(shapeId);
	}

	private positionBaseHoverCard(card: HTMLElement, target: HTMLElement, root: HTMLElement) {
		const rect = target.getBoundingClientRect();
		const cardRect = card.getBoundingClientRect();
		const hoverFrame = (root.closest('.workspace-leaf-content') as HTMLElement | null) || root;
		const frameRect = hoverFrame.getBoundingClientRect();
		const viewportWidth = frameRect.width;
		const viewportHeight = frameRect.height;
		const gap = 8;
		const minLeft = frameRect.left + 12;
		const maxRight = frameRect.right - 12;
		const minTop = frameRect.top + 12;
		const maxBottom = frameRect.bottom - 12;
		const fitsRight = rect.right + gap + cardRect.width <= maxRight;
		const fitsLeft = rect.left - gap - cardRect.width >= minLeft;
		let left = rect.left;
		let top = rect.bottom + 2;
		if (fitsRight) {
			left = rect.right + gap;
			top = rect.top;
		} else if (fitsLeft) {
			left = rect.left - cardRect.width - gap;
			top = rect.top;
		} else {
			if (left + cardRect.width > maxRight) {
				left = Math.max(minLeft, maxRight - cardRect.width);
			}
			if (top + cardRect.height > maxBottom) {
				top = Math.max(minTop, rect.top - cardRect.height - 2);
			}
		}
		if (top + cardRect.height > maxBottom) {
			top = Math.max(minTop, maxBottom - cardRect.height);
		}
		card.style.left = `${Math.round(left)}px`;
		card.style.top = `${Math.round(top)}px`;
	}

	private showBaseHoverCard(target: HTMLElement, citekey: string, root: HTMLElement) {
		if (!this.settings.showCitationHoverCard) {
			this.hideBaseHoverCard();
			return;
		}
		this.clearBaseHoverSwitchTimer();
		if (this._baseHoverHideTimer != null) {
			window.clearTimeout(this._baseHoverHideTimer);
			this._baseHoverHideTimer = null;
		}
		if (this._baseHoverTargetEl === target && this._baseHoverCardEl?.isConnected && this._baseHoverRootEl === root) {
			this.positionBaseHoverCard(this._baseHoverCardEl, target, root);
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
		this._baseHoverRootEl = root;
		this.positionBaseHoverCard(card, target, root);
		window.requestAnimationFrame(() => {
			if (this._baseHoverCardEl === card && this._baseHoverTargetEl === target && this._baseHoverRootEl === root) {
				this.positionBaseHoverCard(card, target, root);
			}
		});
	}

	private scheduleSwitchBaseHoverCard(target: HTMLElement, citekey: string, root: HTMLElement) {
		this.clearBaseHoverSwitchTimer();
		this._baseHoverSwitchTimer = window.setTimeout(() => {
			this._baseHoverSwitchTimer = null;
			this.showBaseHoverCard(target, citekey, root);
		}, 120);
	}

	private handleDocumentMouseOver(event: MouseEvent) {
		if (!this.settings.showCitationHoverCard) {
			this.hideBaseHoverCard();
			return;
		}
		if (Date.now() < this._suppressBaseHoverUntil) {
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
		const container = this.getBaseViewContainer(leaf);
		const leafFile = this.getLeafFile(leaf) ?? this.app.workspace.getActiveFile();
		if (leafFile instanceof TFile && leafFile.extension === 'canvas' && !this.isDiscourseCanvasLeaf(leaf)) {
			this.hideBaseHoverCard();
			return;
		}
		if (!(root instanceof HTMLElement)) {
			this.hideBaseHoverCard();
			return;
		}
		if (!root.contains(target) && !(container instanceof HTMLElement && container.contains(target))) return;
		if (this.isIgnoredBaseHoverElement(target)) {
			this.scheduleHideBaseHoverCard();
			return;
		}
		if (this.settings.enableDiscourseGraphsCompatibility && this.isDiscourseCanvasLeaf(leaf) && leafFile instanceof TFile) {
			return;
		}

		const hoverTarget = this.findBaseHoverTargetFromPoint(event.clientX, event.clientY, root) || this.findBaseHoverTarget(target, root);
		if (!hoverTarget) {
			this.scheduleHideBaseHoverCard();
			return;
		}
		if (this.settings.enableDiscourseGraphsCompatibility && this.isDiscourseCanvasLeaf(leaf) && this.isSourceNodeLikeHoverTarget(hoverTarget)) {
			this.hideBaseHoverCard();
			return;
		}
		if (this._baseHoverTargetEl === hoverTarget.element && this._baseHoverCardEl?.isConnected) {
			if (this._baseHoverHideTimer != null) {
				window.clearTimeout(this._baseHoverHideTimer);
				this._baseHoverHideTimer = null;
			}
			this.clearBaseHoverSwitchTimer();
			return;
		}
		if (this._baseHoverCardEl?.isConnected && this._baseHoverTargetEl) {
			this.scheduleSwitchBaseHoverCard(hoverTarget.element, hoverTarget.citekey, root);
			return;
		}
		this.showBaseHoverCard(hoverTarget.element, hoverTarget.citekey, root);
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
		const container = this.getBaseViewContainer(leaf);
		if (!(container instanceof HTMLElement)) return;
		const root = this.getBaseViewRoot(leaf);
		const file = this.getLeafFile(leaf) ?? this.app.workspace.getActiveFile();
		if (file instanceof TFile && this.isDiscourseCanvasLeaf(leaf)) {
			const cleanups: Array<() => void> = [];
			void this.getDiscourseCanvasModel(file);
			const discourseView = leaf?.view as { store?: { listen?: (cb: () => void) => () => void } } | undefined;
			const store = discourseView?.store;
			if (store && typeof store.listen === 'function') {
				this.discourseDebug('attach-discourse-store-sync', {
					filePath: file.path,
				});
				const unsubscribe = store.listen(() => {
					this.scheduleDiscourseSelectionSync(leaf, file.path, 45);
					this.scheduleDiscourseHoverSync(leaf, file.path, 0);
				});
				if (typeof unsubscribe === 'function') {
					cleanups.push(unsubscribe);
				}
			}
			this.startDiscourseStatePoll(leaf, file.path);

			this._baseViewRootCleanup = () => {
				for (const cleanup of cleanups) {
					try {
						cleanup();
					} catch {
						// Best effort cleanup only.
					}
				}
			};
			this.scheduleDiscourseSelectionSync(leaf, file.path, 0);
		} else if (file instanceof TFile) {
			const syncBaseSelection = (event?: Event) => {
				const eventTarget = event?.target instanceof HTMLElement ? event.target : null;
				void this.syncGenericBaseSelectionForLeaf(leaf, file, eventTarget);
			};
			container.addEventListener('click', syncBaseSelection, true);
			container.addEventListener('keyup', syncBaseSelection, true);
			container.addEventListener('focusin', syncBaseSelection, true);
			this._baseViewRootCleanup = () => {
				container.removeEventListener('click', syncBaseSelection, true);
				container.removeEventListener('keyup', syncBaseSelection, true);
				container.removeEventListener('focusin', syncBaseSelection, true);
			};
			syncBaseSelection();
		}
		this._baseViewObserver = new MutationObserver(() => {
			this.hideBaseHoverCard();
			this.scheduleBaseViewRefresh();
			if (file instanceof TFile && this.isDiscourseCanvasLeaf(leaf)) {
				this.scheduleDiscourseSelectionSync(leaf, file.path, 90);
			} else if (file instanceof TFile) {
				void this.syncGenericBaseSelectionForLeaf(leaf, file);
			}
		});
		this._baseViewObserver.observe(container, {
			childList: true,
			subtree: true,
			characterData: true,
			attributes: true,
		});
	}

	private getBaseInteractionOwner(target: HTMLElement | null, root: HTMLElement): HTMLElement | null {
		if (!(target instanceof HTMLElement) || !root.contains(target)) return null;
		return target.closest<HTMLElement>('[role="gridcell"], td, .table-cell-wrapper, .table-cell, [data-node-id], .canvas-node, .internal-link, a');
	}

	private getBaseInteractionCitekeys(target: HTMLElement | null, root: HTMLElement): string[] {
		const owner = this.getBaseInteractionOwner(target, root);
		if (!(owner instanceof HTMLElement)) return [];
		const exact = this.extractStandaloneCitationFromElement(owner);
		const nearby = exact ? null : this.findStandaloneCitationInNearbySubtree(owner, 5, 28);
		const citekey = (exact || nearby?.citekey || '').replace(/^@+/, '').trim();
		return citekey ? this.normalizeSidebarSelectedCitekeys([citekey]) : [];
	}

	private getBaseInteractionNodeIds(target: HTMLElement | null, root: HTMLElement, file: TFile): string[] {
		const owner = this.getBaseInteractionOwner(target, root);
		if (!(owner instanceof HTMLElement)) return [];
		const nodeId = this.resolveDiscourseNodeIdFromElement(owner, file.path);
		return nodeId ? [nodeId] : [];
	}

	private async syncGenericBaseSelectionForLeaf(leaf: WorkspaceLeaf | null, file: TFile, interactionTarget?: HTMLElement | null) {
		const root = this.getBaseViewRoot(leaf);
		if (!(root instanceof HTMLElement)) {
			this._baseSelectionAnchorByFile.delete(file.path);
			await this.clearSidebarSelectedContext(file.path);
			await this.clearSidebarFocusedDiscourseNodes(file.path);
			return;
		}
		const interactedCitekeys = this.getBaseInteractionCitekeys(interactionTarget || null, root);
		const interactedNodeIds = this.getBaseInteractionNodeIds(interactionTarget || null, root, file);
		if (interactedCitekeys.length > 0 || interactedNodeIds.length > 0) {
			this.setBaseSelectionAnchor(file.path, interactedCitekeys, interactedNodeIds);
		}
		const anchor = this.getBaseSelectionAnchor(file.path);
		const selectedCitekeys = this.getBaseSelectedCitekeys(root);
		const selectedNodeIds = this.getBaseSelectedDiscourseNodeIds(root, file);
		const citekeys = interactedCitekeys.length > 0
			? interactedCitekeys
			: selectedCitekeys.length > 0
				? selectedCitekeys
				: (anchor?.citekeys || []);
		if (citekeys.length > 0) {
			await this.setSidebarSelectedContext({
				kind: citekeys.length > 1 ? 'multi' : 'text',
				citekeys,
				source: 'base-selection',
			}, file.path);
		} else if (this.getSidebarSelectedContext(file.path)?.source === 'base-selection') {
			await this.clearSidebarSelectedContext(file.path);
		}
		const nodeIds = interactedNodeIds.length > 0
			? interactedNodeIds
			: selectedNodeIds.length > 0
				? selectedNodeIds
				: (anchor?.nodeIds || []);
		if (nodeIds.length > 0) {
			await this.setSidebarFocusedDiscourseNodes(nodeIds, file.path, 'base-selection');
		} else if (this._sidebarFocusedDiscourseNodes?.filePath === file.path && this._sidebarFocusedDiscourseNodes.source === 'base-selection') {
			await this.clearSidebarFocusedDiscourseNodes(file.path);
		}
	}

	private scheduleDiscourseSelectionSync(leaf: WorkspaceLeaf | null, filePath: string, delayMs: number = 30) {
		if (this._discourseSelectionSyncTimer != null) {
			window.clearTimeout(this._discourseSelectionSyncTimer);
		}
		this._discourseSelectionSyncTimer = window.setTimeout(() => {
			this._discourseSelectionSyncTimer = null;
			void this.syncDiscourseSelectionForLeaf(leaf, filePath);
		}, delayMs);
	}

	private startDiscourseStatePoll(leaf: WorkspaceLeaf | null, filePath: string) {
		if (this._discourseStatePollTimer != null) {
			window.clearInterval(this._discourseStatePollTimer);
			this._discourseStatePollTimer = null;
		}
		if (getDiscourseViewStore(leaf)?.listen) {
			return;
		}
		const run = () => {
			void this.syncDiscourseSelectionForLeaf(leaf, filePath);
			void this.syncDiscourseHoverForLeaf(leaf, filePath);
		};
		run();
		this._discourseStatePollTimer = window.setInterval(run, 320);
	}

	private async syncDiscourseSelectionForLeaf(leaf: WorkspaceLeaf | null, filePath: string) {
		await syncDiscourseSelection({
			filePath,
			leaf,
			locateSuppressUntil: this._discourseLocateSuppressUntil,
			getRoot: (targetLeaf) => this.getBaseViewRoot(targetLeaf),
			resolveSelectedNodeIds: (targetLeaf, targetFilePath) => this.resolveSelectedDiscourseNodeIdsFromStore(targetLeaf, targetFilePath),
			resolveSelectedContext: (targetLeaf, targetFilePath, root) => this.resolveSelectedDiscourseContextForLeaf(root, targetFilePath, targetLeaf),
			getFocusedDiscourseState: () => this._sidebarFocusedDiscourseNodes,
			debugOnce: (label, payload) => this.discourseSelectionSyncDebugOnce(label, payload),
			setFocusedNodes: (nodeIds, targetFilePath) => this.setSidebarFocusedDiscourseNodes(nodeIds, targetFilePath, 'canvas-selection'),
			clearFocusedNodes: (targetFilePath) => this.clearSidebarFocusedDiscourseNodes(targetFilePath),
			setSelectedContext: (context, targetFilePath) => this.setSidebarSelectedContext(context, targetFilePath),
			clearSelectedContext: (targetFilePath) => this.clearSidebarSelectedContext(targetFilePath),
		});
	}

	private scheduleDiscourseHoverSync(leaf: WorkspaceLeaf | null, filePath: string, delayMs: number = 0) {
		window.setTimeout(() => {
			void this.syncDiscourseHoverForLeaf(leaf, filePath);
		}, delayMs);
	}

	private async syncDiscourseHoverForLeaf(leaf: WorkspaceLeaf | null, filePath: string) {
		await syncDiscourseHover({
			filePath,
			leaf,
			showCitationHoverCard: this.settings.showCitationHoverCard,
			getRoot: (targetLeaf) => this.getBaseViewRoot(targetLeaf),
			resolveHoveredText: (targetLeaf, targetFilePath, root) => this.resolveHoveredDiscourseTextFromStore(targetLeaf, targetFilePath, root),
			hideHoverCard: () => this.hideBaseHoverCard(),
			isCurrentHoverTarget: (anchor, root) => this._baseHoverTargetEl === anchor && !!this._baseHoverCardEl?.isConnected && this._baseHoverRootEl === root,
			hasConnectedHoverCard: () => !!(this._baseHoverCardEl?.isConnected && this._baseHoverTargetEl),
			positionCurrentHoverCard: (anchor, root) => {
				if (this._baseHoverCardEl) {
					this.positionBaseHoverCard(this._baseHoverCardEl, anchor, root);
				}
			},
			scheduleSwitchHoverCard: (anchor, citekey, root) => this.scheduleSwitchBaseHoverCard(anchor, citekey, root),
			showHoverCard: (anchor, citekey, root) => this.showBaseHoverCard(anchor, citekey, root),
			clearHideTimer: () => {
				if (this._baseHoverHideTimer != null) {
					window.clearTimeout(this._baseHoverHideTimer);
					this._baseHoverHideTimer = null;
				}
			},
			clearSwitchTimer: () => this.clearBaseHoverSwitchTimer(),
		});
	}

	private handleDocumentMouseDown(event: MouseEvent) {
		const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
		const target = path.find((node): node is HTMLElement => node instanceof HTMLElement)
			|| (event.target instanceof HTMLElement ? event.target : null);
		if (this.isSidebarTarget(target, path)) {
			return;
		}
		if (!(target instanceof HTMLElement)) {
			this.hideBaseHoverCard();
			return;
		}
		if (this._baseHoverCardEl && this._baseHoverCardEl.contains(target)) {
			return;
		}
		const activeLeaf = this.app.workspace.activeLeaf ?? this.app.workspace.getMostRecentLeaf();
		const root = this._baseHoverRootEl ?? this.getBaseViewRoot(activeLeaf);
		const container = this.getBaseViewContainer(activeLeaf);
		if (!(root instanceof HTMLElement)) {
			this.hideBaseHoverCard();
			return;
		}
		const rootContainsTarget = root.contains(target)
			|| path.includes(root)
			|| (container instanceof HTMLElement && (container.contains(target) || path.includes(container)));
		if (!rootContainsTarget) {
			this.hideBaseHoverCard();
			return;
		}
		if (this.isIgnoredBaseHoverElement(target)) {
			this.hideBaseHoverCard();
			return;
		}
		this.hideBaseHoverCard();
	}

	private handleDocumentClick(event: MouseEvent) {
		const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
		const target = path.find((node): node is HTMLElement => node instanceof HTMLElement)
			|| (event.target instanceof HTMLElement ? event.target : null);
		if (this.isSidebarTarget(target, path)) {
			return;
		}
		const context = this.getCanvasLikeLeafAndFile();
		if (!context) return;
		if (this.settings.enableDiscourseGraphsCompatibility) return;
		const { file: activeFile, root } = context;
		if (!(target instanceof HTMLElement)) return;
		if (this._baseHoverCardEl?.contains(target)) return;
		const rootContainsTarget = root.contains(target) || path.includes(root);
		if (!rootContainsTarget) return;
		if (this.isIgnoredBaseHoverElement(target)) return;

		const filePath = activeFile.path;
		this.hideBaseHoverCard();
		this._suppressBaseHoverUntil = Date.now() + 450;
		void (async () => {
			const clickedFocused = await this.resolveDiscourseCanvasClickedCitekey(activeFile, event, root);
			if (clickedFocused) {
				await this.setSidebarFocusedCitekey(clickedFocused, filePath);
			} else {
				await this.clearSidebarFocusedCitekey(filePath);
			}
		})();
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
				void this.refreshSidebarView();
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

		let entries: CitationIndexEntry[] = this._indexByScope.get(scope) || [];
		if (entries.length === 0) {
			entries = this.loadCitationIndexFromDisk(scope);
		}
		const cachedMatches = this.searchEntries(entries, q, limit);
		if (cachedMatches.length > 0) {
			void this.ensureCitationIndex(scope, false).catch(() => {
				/* background refresh */
			});
			return cachedMatches;
		}

		void this.ensureCitationIndex(scope, false).catch(() => {
			/* background refresh */
		});

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

		return this.searchEntries(entries, q, limit);
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
				zoteroDataDir: this.settings.zoteroDataDir || undefined,
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

	async loadDiscourseConfigIfNeeded(): Promise<void> {
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
				this._discourseNodeTypes = cfg.nodeTypes
					.map((node) => {
						if (!node || typeof node !== 'object') return null;
						const n = node as Record<string, unknown>;
						const id = typeof n.id === 'string' ? n.id : '';
						const name = typeof n.name === 'string' ? n.name : '';
						if (!id || !name) return null;
						return {
							id,
							name,
							format: typeof n.format === 'string' ? n.format : '',
							color: typeof n.color === 'string' ? n.color : '',
						} as DiscourseNodeTypeInfo;
					})
					.filter((node): node is DiscourseNodeTypeInfo => !!node);
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

	getDiscourseNodeTypes(): DiscourseNodeTypeInfo[] {
		return [...this._discourseNodeTypes];
	}

	private getDiscourseNodeTypeById(nodeTypeId: string | null | undefined): DiscourseNodeTypeInfo | null {
		if (typeof nodeTypeId !== 'string' || !nodeTypeId) return null;
		return this._discourseNodeTypes.find((nodeType) => nodeType.id === nodeTypeId) || null;
	}

	private shouldShowDiscourseNodeType(nodeTypeId: string | null | undefined): boolean {
		const selectedIds = this.settings.discourseGraphVisibleNodeTypeIds || [];
		if (selectedIds.length === 0) return true;
		if (typeof nodeTypeId !== 'string' || !nodeTypeId) return false;
		return selectedIds.includes(nodeTypeId);
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

		this.addCommand({
			id: 'refresh-zotero-connection-and-index',
			name: 'Zotsidian: Refresh Zotero connection and index',
			callback: async () => {
				await this.refreshActiveScopeAndView(true);
			}
		});

		this.addCommand({
			id: 'debug-dump-discourse-canvas-snapshot',
			name: 'Zotsidian: Debug dump active discourse canvas snapshot',
			callback: async () => {
				await this.dumpActiveDiscourseCanvasDebugSnapshot();
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
			await this.syncActiveMarkdownLineContext();
		}));

		this.registerEvent(this.app.workspace.on('active-leaf-change', async (leaf: WorkspaceLeaf | null) => {
			if (leaf?.view instanceof ReferencesView) {
				return;
			}
			this.syncActiveBaseViewSupport(leaf);
			const file = this.getLeafFile(leaf) ?? this.app.workspace.getActiveFile();
			if (!file) {
				await this.setActiveFilePath('');
				return;
			}
			if (file.path === this.activeFilePath) {
				await this.refreshSidebarView();
				await this.syncActiveMarkdownLineContext();
				return;
			}
			await this.setActiveFilePath(file.path);
			await this.syncActiveMarkdownLineContext();
		}));

		this.registerEvent(this.app.workspace.on('editor-change', async (_editor, info) => {
			const file = info.file;
			if (!(file instanceof TFile)) return;
			if (file.path !== this.activeFilePath) return;
			await this.syncActiveMarkdownLineContext();
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
			this.registerDomEvent(document, 'mousemove', (event: MouseEvent) => this.handleDocumentMouseOver(event));
			this.registerDomEvent(document, 'mouseout', (event: MouseEvent) => this.handleDocumentMouseOut(event));
			this.registerDomEvent(document, 'mousedown', (event: MouseEvent) => this.handleDocumentMouseDown(event));
			this.registerDomEvent(document, 'pointerdown', (event: MouseEvent) => this.handleDocumentMouseDown(event), { capture: true });
			this.registerDomEvent(document, 'click', (event: MouseEvent) => this.handleDocumentClick(event), { capture: true });

		this.addSettingTab(new ZotsidianSettingTab(this.app, this));

		this.app.workspace.onLayoutReady(async () => {
			await this.initLeaf();
			this.syncActiveBaseViewSupport(this.app.workspace.activeLeaf ?? this.app.workspace.getMostRecentLeaf());
			const initialFile = this.getLeafFile(this.app.workspace.activeLeaf ?? this.app.workspace.getMostRecentLeaf())
				?? this.app.workspace.getActiveFile();
			if (initialFile instanceof TFile) {
				await this.setActiveFilePath(initialFile.path);
				await this.syncActiveMarkdownLineContext();
			}
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

		this.registerInterval(window.setInterval(() => {
			void this.syncActiveMarkdownLineContext();
		}, 360));
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
			zoteroDataDir: this.settings.zoteroDataDir,
			showSourceRelatedPapers: this.settings.showSourceRelatedPapers,
			relatedPapersProvider: this.settings.relatedPapersProvider,
			citationInsertFormat: this.settings.citationInsertFormat,
			showCitationHoverCard: this.settings.showCitationHoverCard,
			citationHoverOpenAction: this.settings.citationHoverOpenAction,
			enableDiscourseGraphsCompatibility: this.settings.enableDiscourseGraphsCompatibility,
			discourseGraphVisibleNodeTypeIds: Array.isArray(this.settings.discourseGraphVisibleNodeTypeIds)
				? [...this.settings.discourseGraphVisibleNodeTypeIds]
				: [],
			enableDiscourseDebugLogging: this.settings.enableDiscourseDebugLogging,
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
