import type { WorkspaceLeaf } from 'obsidian';

type SidebarSelectedContext = {
	kind: 'node' | 'text' | 'multi';
	citekeys: string[];
	source: 'editor-line' | 'canvas-selection' | 'canvas-source-node' | 'base-selection';
};

type FocusedDiscourseState = {
	filePath: string;
	source: 'canvas-selection' | 'editor-line' | 'base-selection';
};

type SelectionSyncDeps = {
	filePath: string;
	leaf: WorkspaceLeaf | null;
	locateSuppressUntil: number;
	getRoot: (leaf: WorkspaceLeaf | null) => HTMLElement | null;
	resolveSelectedNodeIds: (leaf: WorkspaceLeaf | null, filePath: string) => Promise<string[]>;
	resolveSelectedContext: (leaf: WorkspaceLeaf | null, filePath: string, root: HTMLElement) => SidebarSelectedContext | null;
	getFocusedDiscourseState: () => FocusedDiscourseState | null;
	debugOnce: (label: string, payload: Record<string, unknown>) => void;
	setFocusedNodes: (nodeIds: string[], filePath: string) => Promise<void>;
	clearFocusedNodes: (filePath: string) => Promise<void>;
	setSelectedContext: (context: SidebarSelectedContext, filePath: string) => Promise<void>;
	clearSelectedContext: (filePath: string) => Promise<void>;
};

type HoverSyncDeps = {
	filePath: string;
	leaf: WorkspaceLeaf | null;
	showCitationHoverCard: boolean;
	getRoot: (leaf: WorkspaceLeaf | null) => HTMLElement | null;
	resolveHoveredText: (leaf: WorkspaceLeaf | null, filePath: string, root: HTMLElement) => { citekey: string; element: HTMLElement | null } | null;
	hideHoverCard: () => void;
	isCurrentHoverTarget: (anchor: HTMLElement, root: HTMLElement) => boolean;
	hasConnectedHoverCard: () => boolean;
	positionCurrentHoverCard: (anchor: HTMLElement, root: HTMLElement) => void;
	scheduleSwitchHoverCard: (anchor: HTMLElement, citekey: string, root: HTMLElement) => void;
	showHoverCard: (anchor: HTMLElement, citekey: string, root: HTMLElement) => void;
	clearHideTimer: () => void;
	clearSwitchTimer: () => void;
};

export async function syncDiscourseSelection(deps: SelectionSyncDeps): Promise<void> {
	const root = deps.getRoot(deps.leaf);
	if (!(root instanceof HTMLElement)) {
		deps.debugOnce('selection-sync-no-root', { filePath: deps.filePath });
		await deps.clearSelectedContext(deps.filePath);
		await deps.clearFocusedNodes(deps.filePath);
		return;
	}

	const selectedNodeIds = await deps.resolveSelectedNodeIds(deps.leaf, deps.filePath);
	const focusedState = deps.getFocusedDiscourseState();
	if (selectedNodeIds.length > 0) {
		await deps.setFocusedNodes(selectedNodeIds, deps.filePath);
	} else if (focusedState?.filePath === deps.filePath && focusedState.source === 'canvas-selection') {
		await deps.clearFocusedNodes(deps.filePath);
	}

	const selected = deps.resolveSelectedContext(deps.leaf, deps.filePath, root);
	if (selected) {
		deps.debugOnce('selection-sync-using-selected-context', {
			filePath: deps.filePath,
			selected,
		});
		await deps.setSelectedContext(selected, deps.filePath);
		return;
	}

	if (Date.now() < deps.locateSuppressUntil) {
		deps.debugOnce('selection-sync-suppressed-clear', { filePath: deps.filePath });
		return;
	}

	deps.debugOnce('selection-sync-clearing-focus', { filePath: deps.filePath });
	await deps.clearSelectedContext(deps.filePath);
}

export async function syncDiscourseHover(deps: HoverSyncDeps): Promise<void> {
	if (!deps.showCitationHoverCard) {
		deps.hideHoverCard();
		return;
	}
	const root = deps.getRoot(deps.leaf);
	if (!(root instanceof HTMLElement)) {
		deps.hideHoverCard();
		return;
	}
	const hovered = deps.resolveHoveredText(deps.leaf, deps.filePath, root);
	if (!hovered?.citekey || !(hovered.element instanceof HTMLElement)) {
		deps.hideHoverCard();
		return;
	}

	const anchor = hovered.element;
	if (deps.isCurrentHoverTarget(anchor, root)) {
		deps.clearHideTimer();
		deps.clearSwitchTimer();
		deps.positionCurrentHoverCard(anchor, root);
		return;
	}
	if (deps.hasConnectedHoverCard()) {
		deps.scheduleSwitchHoverCard(anchor, hovered.citekey, root);
		return;
	}
	deps.showHoverCard(anchor, hovered.citekey, root);
}
