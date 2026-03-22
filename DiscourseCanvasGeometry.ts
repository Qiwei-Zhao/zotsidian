import type {
	DiscourseCanvasModel,
	DiscourseCanvasNodeEntry,
	DiscourseCanvasTextEntry,
} from 'DiscourseCanvasModel';

export type DiscourseCanvasGeometryHit = {
	citekey: string;
	element: HTMLElement | null;
	kind: 'node' | 'text';
};

type GeometryDeps = {
	pointInRect: (x: number, y: number, rect: DOMRect) => boolean;
};

export function getDiscourseCanvasViewport(root: HTMLElement): HTMLElement {
	return (
		root.querySelector<HTMLElement>('.tl-canvas') ||
		root.querySelector<HTMLElement>('.tl-canvas__canvas') ||
		root.querySelector<HTMLElement>('.tl-shapes') ||
		root
	);
}

export function getDiscourseCanvasActivePageId(root: HTMLElement, model: DiscourseCanvasModel): string | null {
	const visibleShapeIds = Array.from(root.querySelectorAll<HTMLElement>('.tl-shape[data-shape-id], [data-shape-id^="shape:"]'))
		.map((element) => element.getAttribute('data-shape-id') || '')
		.filter(Boolean);
	if (visibleShapeIds.length > 0) {
		const counts = new Map<string, number>();
		for (const shapeId of visibleShapeIds) {
			const node = model.nodes.get(shapeId);
			if (node?.pageId) {
				counts.set(node.pageId, (counts.get(node.pageId) || 0) + 1);
				continue;
			}
			const textShape = model.textShapes.find((entry) => entry.shapeId === shapeId);
			if (textShape?.pageId) {
				counts.set(textShape.pageId, (counts.get(textShape.pageId) || 0) + 1);
			}
		}
		const ranked = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
		if (ranked[0]?.[0]) {
			return ranked[0][0];
		}
	}
	if (model.currentPageId) return model.currentPageId;
	return model.pageNames.keys().next().value || null;
}

export function getRenderedDiscourseShapeElement(root: HTMLElement, shapeId: string): HTMLElement | null {
	const escaped = typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(shapeId) : shapeId.replace(/"/g, '\\"');
	return root.querySelector<HTMLElement>(`.tl-shape[data-shape-id="${escaped}"], [data-shape-id="${escaped}"]`);
}

function discourseCanvasClientToPagePoint(
	root: HTMLElement,
	model: DiscourseCanvasModel,
	pageId: string,
	clientX: number,
	clientY: number,
): { x: number; y: number } | null {
	const viewport = getDiscourseCanvasViewport(root);
	const rect = viewport.getBoundingClientRect();
	if (!rect.width || !rect.height) return null;
	const camera = model.cameras.get(pageId) || { pageId, x: 0, y: 0, z: 1 };
	const z = camera.z && camera.z > 0 ? camera.z : 1;
	return {
		x: (clientX - rect.left) / z + camera.x,
		y: (clientY - rect.top) / z + camera.y,
	};
}

function hitTestDiscourseNode(
	model: DiscourseCanvasModel,
	pageId: string,
	pageX: number,
	pageY: number,
): DiscourseCanvasNodeEntry | null {
	const candidates = Array.from(model.nodes.values())
		.filter((entry) => entry.pageId === pageId && entry.citekey)
		.filter((entry) => pageX >= entry.x && pageX <= entry.x + entry.w && pageY >= entry.y && pageY <= entry.y + entry.h)
		.sort((a, b) => (a.w * a.h) - (b.w * b.h));
	return candidates[0] || null;
}

function hitTestDiscourseTextShape(
	model: DiscourseCanvasModel,
	pageId: string,
	pageX: number,
	pageY: number,
): DiscourseCanvasTextEntry | null {
	const margin = 6;
	const candidates = model.textShapes
		.filter((entry) => entry.pageId === pageId && entry.primaryCitekey)
		.filter((entry) => pageX >= entry.x - margin && pageX <= entry.x + entry.w + margin && pageY >= entry.y - margin && pageY <= entry.y + entry.h + margin)
		.sort((a, b) => (a.w * a.h) - (b.w * b.h));
	return candidates[0] || null;
}

function getDiscourseRenderedShapeRectHit(
	root: HTMLElement,
	model: DiscourseCanvasModel,
	pageId: string,
	clientX: number,
	clientY: number,
	deps: GeometryDeps,
): DiscourseCanvasGeometryHit | null {
	const hits: Array<{ citekey: string; element: HTMLElement; kind: 'node' | 'text'; area: number; distance: number; containsPoint: boolean }> = [];

	for (const entry of model.nodes.values()) {
		if (entry.pageId !== pageId || !entry.citekey) continue;
		const element = getRenderedDiscourseShapeElement(root, entry.shapeId);
		if (!(element instanceof HTMLElement)) continue;
		const rect = element.getBoundingClientRect();
		const containsPoint = deps.pointInRect(clientX, clientY, rect);
		const margin = 10;
		const near =
			clientX >= rect.left - margin &&
			clientX <= rect.right + margin &&
			clientY >= rect.top - margin &&
			clientY <= rect.bottom + margin;
		if (!containsPoint && !near) continue;
		const cx = rect.left + rect.width / 2;
		const cy = rect.top + rect.height / 2;
		hits.push({
			citekey: entry.citekey,
			element,
			kind: 'node',
			area: Math.max(1, rect.width * rect.height),
			distance: Math.hypot(clientX - cx, clientY - cy),
			containsPoint,
		});
	}

	for (const entry of model.textShapes) {
		if (entry.pageId !== pageId || !entry.primaryCitekey) continue;
		const element = getRenderedDiscourseShapeElement(root, entry.shapeId);
		if (!(element instanceof HTMLElement)) continue;
		const rect = element.getBoundingClientRect();
		const containsPoint = deps.pointInRect(clientX, clientY, rect);
		const margin = 8;
		const near =
			clientX >= rect.left - margin &&
			clientX <= rect.right + margin &&
			clientY >= rect.top - margin &&
			clientY <= rect.bottom + margin;
		if (!containsPoint && !near) continue;
		const cx = rect.left + rect.width / 2;
		const cy = rect.top + rect.height / 2;
		hits.push({
			citekey: entry.primaryCitekey,
			element,
			kind: 'text',
			area: Math.max(1, rect.width * rect.height),
			distance: Math.hypot(clientX - cx, clientY - cy),
			containsPoint,
		});
	}

	if (hits.length === 0) return null;
	hits.sort((a, b) => {
		if (a.containsPoint !== b.containsPoint) return a.containsPoint ? -1 : 1;
		if (a.kind !== b.kind) return a.kind === 'node' ? -1 : 1;
		return a.distance - b.distance || a.area - b.area;
	});
	const winner = hits[0];
	return { citekey: winner.citekey, element: winner.element, kind: winner.kind };
}

export function getDiscourseCanvasGeometryHitFromModel(
	root: HTMLElement,
	model: DiscourseCanvasModel,
	clientX: number,
	clientY: number,
	deps: GeometryDeps,
): DiscourseCanvasGeometryHit | null {
	const pageId = getDiscourseCanvasActivePageId(root, model);
	if (!pageId) return null;

	const renderedHit = getDiscourseRenderedShapeRectHit(root, model, pageId, clientX, clientY, deps);
	if (renderedHit) return renderedHit;

	const point = discourseCanvasClientToPagePoint(root, model, pageId, clientX, clientY);
	if (!point) return null;

	const nodeHit = hitTestDiscourseNode(model, pageId, point.x, point.y);
	if (nodeHit?.citekey) {
		return {
			citekey: nodeHit.citekey,
			element: getRenderedDiscourseShapeElement(root, nodeHit.shapeId),
			kind: 'node',
		};
	}

	const textHit = hitTestDiscourseTextShape(model, pageId, point.x, point.y);
	if (textHit?.primaryCitekey) {
		return {
			citekey: textHit.primaryCitekey,
			element: getRenderedDiscourseShapeElement(root, textHit.shapeId),
			kind: 'text',
		};
	}

	return null;
}
