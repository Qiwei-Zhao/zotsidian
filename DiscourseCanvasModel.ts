import { citationsInText } from "ReferenceProcessing";

export type DiscourseCanvasNodeEntry = {
	shapeId: string;
	pageId: string;
	x: number;
	y: number;
	w: number;
	h: number;
	title: string;
	src: string;
	nodeTypeId: string | null;
	citekey: string | null;
};

export type DiscourseCanvasTextEntry = {
	shapeId: string;
	pageId: string;
	x: number;
	y: number;
	w: number;
	h: number;
	text: string;
	citekeys: string[];
	primaryCitekey: string | null;
};

export type DiscourseCanvasCameraEntry = {
	pageId: string;
	x: number;
	y: number;
	z: number;
};

export type DiscourseCanvasModel = {
	mtime: number;
	nodes: Map<string, DiscourseCanvasNodeEntry>;
	textShapes: DiscourseCanvasTextEntry[];
	pageCitekeys: Map<string, string[]>;
	cameras: Map<string, DiscourseCanvasCameraEntry>;
	pageNames: Map<string, string>;
	currentPageId: string | null;
};

type DiscourseCanvasBuildDeps = {
	extractCitekeyFromDiscourseNodeTitle: (title: string) => string | null;
	extractPlainTextFromTldrawRichText: (richText: unknown) => string;
	normalizeHoverText: (text: string) => string;
	estimateDiscourseTextHeight: (size: string, text: string) => number;
};

export function buildDiscourseCanvasModel(
	records: Array<Record<string, unknown>>,
	mtime: number,
	deps: DiscourseCanvasBuildDeps,
): DiscourseCanvasModel {
	const nodes = new Map<string, DiscourseCanvasNodeEntry>();
	const textShapes: DiscourseCanvasTextEntry[] = [];
	const pageCitekeys = new Map<string, string[]>();
	const cameras = new Map<string, DiscourseCanvasCameraEntry>();
	const pageNames = new Map<string, string>();
	let currentPageId: string | null = null;

	const pushPageCitekey = (pageId: string, citekey: string | null) => {
		const normalized = (citekey || '').replace(/^@+/, '').trim();
		if (!pageId || !normalized) return;
		const list = pageCitekeys.get(pageId) || [];
		if (!list.includes(normalized)) {
			list.push(normalized);
			pageCitekeys.set(pageId, list);
		}
	};

	for (const record of records) {
		if (!record || typeof record !== 'object') continue;
		const recordId = typeof record.id === 'string' ? record.id : '';
		const typeName = typeof record.typeName === 'string' ? record.typeName : '';
		if (typeName === 'instance' && typeof record.currentPageId === 'string') {
			currentPageId = record.currentPageId;
			continue;
		}
		if (typeName === 'page' && recordId.startsWith('page:')) {
			const pageName = typeof record.name === 'string' ? record.name : recordId.replace(/^page:/, '');
			pageNames.set(recordId, pageName);
			continue;
		}
		if (typeName === 'camera' && typeof record.pageId === 'string') {
			cameras.set(record.pageId, {
				pageId: record.pageId,
				x: typeof record.x === 'number' ? record.x : 0,
				y: typeof record.y === 'number' ? record.y : 0,
				z: typeof record.z === 'number' && record.z > 0 ? record.z : 1,
			});
			continue;
		}

		const shapeId = recordId;
		if (!shapeId.startsWith('shape:')) continue;
		const pageId = typeof record.parentId === 'string' ? record.parentId : '';
		if (!pageId.startsWith('page:')) continue;
		const props = (record.props && typeof record.props === 'object') ? record.props as Record<string, unknown> : {};
		const x = typeof record.x === 'number' ? record.x : 0;
		const y = typeof record.y === 'number' ? record.y : 0;
		const w = typeof props.w === 'number' ? props.w : 0;
		const h = typeof props.h === 'number' ? props.h : 0;

		if (record.type === 'discourse-node') {
			const title = typeof props.title === 'string' ? props.title : '';
			const src = typeof props.src === 'string' ? props.src : '';
			const nodeTypeId = typeof props.nodeTypeId === 'string' ? props.nodeTypeId : null;
			const citekey = deps.extractCitekeyFromDiscourseNodeTitle(title);
			nodes.set(shapeId, {
				shapeId,
				pageId,
				x,
				y,
				w,
				h,
				title,
				src,
				nodeTypeId,
				citekey,
			});
			pushPageCitekey(pageId, citekey);
			continue;
		}

		if (record.type === 'text') {
			const text = deps.normalizeHoverText(
				deps.extractPlainTextFromTldrawRichText(props.richText)
				|| (typeof props.text === 'string' ? props.text : ''),
			);
			if (!text) continue;
			const citekeys = citationsInText(text);
			if (citekeys.length === 0) continue;
			const size = typeof props.size === 'string' ? props.size : 'm';
			textShapes.push({
				shapeId,
				pageId,
				x,
				y,
				w,
				h: h > 0 ? h : deps.estimateDiscourseTextHeight(size, text),
				text,
				citekeys,
				primaryCitekey: citekeys.length === 1 ? citekeys[0] : null,
			});
			for (const citekey of citekeys) {
				pushPageCitekey(pageId, citekey);
			}
		}
	}

	return {
		mtime,
		nodes,
		textShapes,
		pageCitekeys,
		cameras,
		pageNames,
		currentPageId,
	};
}
