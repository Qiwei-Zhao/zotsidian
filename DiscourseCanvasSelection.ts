import type { DiscourseCanvasModel } from 'DiscourseCanvasModel';

export type DiscourseSelectionContext = {
	kind: 'node' | 'text' | 'multi';
	citekeys: string[];
};

type SelectionDeps = {
	normalizeCitekeys: (citekeys: string[]) => string[];
};

function getScopedSelectedShapeIds(
	model: DiscourseCanvasModel,
	selectedShapeIds: string[],
	currentPageId: string | null,
): string[] {
	if (!currentPageId) return selectedShapeIds;
	const scopedShapeIds = selectedShapeIds.filter((shapeId) => {
		const node = model.nodes.get(shapeId);
		if (node) return node.pageId === currentPageId;
		const text = model.textShapes.find((entry) => entry.shapeId === shapeId);
		return text?.pageId === currentPageId;
	});
	return scopedShapeIds.length > 0 ? scopedShapeIds : selectedShapeIds;
}

export function resolveSelectedDiscourseContextFromModel(
	model: DiscourseCanvasModel,
	selectedShapeIds: string[],
	currentPageId: string | null,
	deps: SelectionDeps,
): DiscourseSelectionContext | null {
	if (selectedShapeIds.length === 0) return null;
	const shapeIds = getScopedSelectedShapeIds(model, selectedShapeIds, currentPageId);
	if (shapeIds.length === 0) return null;

	const citekeys: string[] = [];
	const pushCitekeys = (values: string[]) => {
		for (const value of values) {
			const clean = (value || '').replace(/^@+/, '').trim();
			if (clean) citekeys.push(clean);
		}
	};

	let singleKind: 'node' | 'text' | 'multi' | null = null;
	if (shapeIds.length === 1) {
		const node = model.nodes.get(shapeIds[0]);
		if (node?.citekey) {
			singleKind = 'node';
			pushCitekeys([node.citekey]);
		} else {
			const text = model.textShapes.find((entry) => entry.shapeId === shapeIds[0]);
			if (text?.citekeys?.length) {
				singleKind = text.citekeys.length === 1 ? 'text' : 'multi';
				pushCitekeys(text.citekeys);
			}
		}
	} else {
		for (const shapeId of shapeIds) {
			const node = model.nodes.get(shapeId);
			if (node?.citekey) {
				pushCitekeys([node.citekey]);
				continue;
			}
			const text = model.textShapes.find((entry) => entry.shapeId === shapeId);
			if (text?.citekeys?.length) {
				pushCitekeys(text.citekeys);
			}
		}
	}

	const normalized = deps.normalizeCitekeys(citekeys);
	if (normalized.length === 0) return null;
	return {
		kind: normalized.length > 1 ? 'multi' : (singleKind || 'multi'),
		citekeys: normalized,
	};
}

export function resolveSelectedDiscourseSourceCitekeyFromModel(
	model: DiscourseCanvasModel,
	selectedShapeIds: string[],
	currentPageId: string | null,
): string | null {
	if (selectedShapeIds.length === 0) return null;
	const selectedNodes = selectedShapeIds
		.map((shapeId) => model.nodes.get(shapeId))
		.filter((entry): entry is NonNullable<typeof entry> => !!entry && !!entry.citekey);
	if (selectedNodes.length === 0) return null;
	if (selectedNodes.length === 1) return selectedNodes[0].citekey || null;
	const currentPageNodes = currentPageId
		? selectedNodes.filter((entry) => entry.pageId === currentPageId)
		: selectedNodes;
	return currentPageNodes[0]?.citekey || selectedNodes[0]?.citekey || null;
}

export function resolveHoveredDiscoursePrimaryCitekeyFromModel(
	model: DiscourseCanvasModel,
	hoveredShapeId: string | null,
): { citekey: string; shapeId: string } | null {
	if (!hoveredShapeId) return null;
	const textShape = model.textShapes.find((entry) => entry.shapeId === hoveredShapeId && !!entry.primaryCitekey);
	if (!textShape?.primaryCitekey) return null;
	return {
		citekey: textShape.primaryCitekey,
		shapeId: textShape.shapeId,
	};
}
