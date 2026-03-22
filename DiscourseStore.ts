import type { WorkspaceLeaf } from 'obsidian';

export type DiscourseViewStore = {
	allRecords?: () => Array<Record<string, unknown>>;
	records?: { values?: () => Iterable<Record<string, unknown>> };
	get?: (id: string) => Record<string, unknown> | undefined;
	has?: (id: string) => boolean;
	put?: (records: Array<Record<string, unknown>>) => void;
	atomic?: (cb: () => void) => void;
	listen?: (cb: () => void) => (() => void) | void;
};

export function getDiscourseViewStore(leaf: WorkspaceLeaf | null): DiscourseViewStore | null {
	const store = (leaf?.view as { store?: DiscourseViewStore } | undefined)?.store;
	return store || null;
}

export function getDiscourseStoreRecords(leaf: WorkspaceLeaf | null): Array<Record<string, unknown>> {
	const store = getDiscourseViewStore(leaf);
	if (!store) return [];
	try {
		if (typeof store.allRecords === 'function') {
			return store.allRecords().filter((record): record is Record<string, unknown> => !!record && typeof record === 'object');
		}
		if (store.records && typeof store.records.values === 'function') {
			return Array.from(store.records.values()).filter((record): record is Record<string, unknown> => !!record && typeof record === 'object');
		}
	} catch {
		return [];
	}
	return [];
}

export function getDiscourseStoreCurrentPageId(leaf: WorkspaceLeaf | null): string | null {
	const records = getDiscourseStoreRecords(leaf);
	const instance = records.find((record) => record?.typeName === 'instance' && typeof record.currentPageId === 'string');
	return typeof instance?.currentPageId === 'string' ? instance.currentPageId : null;
}

export function getDiscourseStorePageStateRecord(leaf: WorkspaceLeaf | null, pageId: string | null): Record<string, unknown> | null {
	if (!pageId) return null;
	const records = getDiscourseStoreRecords(leaf);
	const pageState = records.find(
		(record) => record?.typeName === 'instance_page_state' && record.pageId === pageId,
	);
	return pageState || null;
}

export function getDiscourseStoreCurrentPageState(leaf: WorkspaceLeaf | null): Record<string, unknown> | null {
	const currentPageId = getDiscourseStoreCurrentPageId(leaf);
	if (!currentPageId) return null;
	return getDiscourseStorePageStateRecord(leaf, currentPageId);
}

export function getDiscourseStoreSelectedShapeIds(leaf: WorkspaceLeaf | null): string[] {
	const pageState = getDiscourseStoreCurrentPageState(leaf);
	const selected = pageState?.selectedShapeIds;
	return Array.isArray(selected) ? selected.filter((id): id is string => typeof id === 'string') : [];
}

export function getDiscourseStoreHoveredShapeId(leaf: WorkspaceLeaf | null): string | null {
	const pageState = getDiscourseStoreCurrentPageState(leaf);
	return typeof pageState?.hoveredShapeId === 'string' ? pageState.hoveredShapeId : null;
}

export function getDiscourseStoreInstanceRecord(leaf: WorkspaceLeaf | null): Record<string, unknown> | null {
	const records = getDiscourseStoreRecords(leaf);
	return records.find((record) => record?.typeName === 'instance' && record.id === 'instance:instance') || null;
}

export function getDiscourseStoreCameraRecord(leaf: WorkspaceLeaf | null, pageId: string | null): Record<string, unknown> | null {
	if (!pageId) return null;
	const records = getDiscourseStoreRecords(leaf);
	return records.find((record) => record?.typeName === 'camera' && record.id === `camera:${pageId}`) || null;
}
