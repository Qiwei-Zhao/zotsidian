import { exportCollectionPath, attachments, normalizeExportItems, isLibraryScopePath, locateCollection, resolveCitekeysToItems, resolveCitekeysToItemsViaLocalApi } from "ZoteroFunctions";

export type CiteKey = string;
export type CollectionPath = string;

export interface Reference {
    citekey: CiteKey;
    library: string;
}

export interface Attachment {
    open: string;
    path: string | boolean;
    label?: string;
    annotations?: Annotation[];
}

export interface Annotation {
    annotationAuthorName: string;
    annotationColor: string; //example "#ffd400"
    annotationComment: string
    // annotationPageLabel: string; // "5"
    // //annotationPosition : // example {pageIndex: 4, rects: Array(4)}
    // //annotationSortIndex: string
    annotationText: string;
    annotationType: string // example "highlight"
    dateAdded: string  // example "2025-03-08T23:41:05Z"
    dateModified: string // example"2025-03-08T23:41:05Z"
    itemType: string // "annotation"
    key: string;
    parentItem: string; 
    //relations: 
    //tags: string[]
    //version: integer // example 60687
}

export interface ItemAnnotationsData {
    reference: Reference;
    parentUri: string;
    annotations: object[];
    itemData: object;
}

export type ItemAnnotationsMap = Map<CiteKey, ItemAnnotationsData>

export interface CollectionData {
    path: CollectionPath;
    library: string;
    bibliography: string[];
    data: Map<string, object>;
    citations?: string[];
    error?: Error;
    annotationsMap: ItemAnnotationsMap
}

export type CollectionAnnotationsMap = Map<CollectionPath, ItemAnnotationsMap>

export type CitationMentionFormat = 'pandoc' | 'plain' | 'wikilink';

export interface CitationMention {
    citekey: string;
    format: CitationMentionFormat;
    from: number;
    to: number;
}

function preferredAttachment(attachmentsList: Attachment[]): Attachment | null {
    if (!attachmentsList || attachmentsList.length === 0) return null;
    const withPath = attachmentsList.filter((attach) => attach.path != false);
    if (withPath.length === 0) return null;
    const pdfFirst = withPath.find((attach) => typeof attach.open === 'string' && attach.open.startsWith('zotero://open-pdf/'));
    return pdfFirst ?? withPath[0];
}

function zoteroUriFromItemData(itemData: Record<string, unknown>): string {
    const explicitZotero = typeof itemData['zotero'] === 'string' ? itemData['zotero'] : '';
    if (explicitZotero.startsWith('zotero://')) {
        return explicitZotero;
    }

    const zoteroItemID = typeof itemData['zoteroItemID'] === 'string' ? itemData['zoteroItemID'] : '';
    if (zoteroItemID) {
        if (zoteroItemID.startsWith('zotero://')) {
            return zoteroItemID;
        }
        const groupMatch = zoteroItemID.match(/\/groups\/([0-9]+)\/items\/([A-Z0-9]{8})/i);
        if (groupMatch?.[1] && groupMatch?.[2]) {
            return `zotero://select/groups/${groupMatch[1]}/items/${groupMatch[2]}`;
        }
        const userMatch = zoteroItemID.match(/\/users\/([0-9]+)\/items\/([A-Z0-9]{8})/i);
        if (userMatch?.[2]) {
            return `zotero://select/library/items/${userMatch[2]}`;
        }
    }

    const itemKey = typeof itemData['itemKey'] === 'string' && itemData['itemKey']
        ? itemData['itemKey'] as string
        : (typeof itemData['zotero-key'] === 'string' ? itemData['zotero-key'] as string : '');
    if (itemKey) {
        return `zotero://select/library/items/${itemKey}`;
    }

    return '';
}

function emptyCollectionData(collectionPath:string = '', library:string = ''): CollectionData {
    return {
        path: collectionPath,
        library: library,
        citations: [],
        bibliography: [],
        data: new Map(),
        annotationsMap: new Map()
    };
}

export async function processCollection(collectionPath:string):Promise<CollectionData>  {

    try {

        const libraryName = collectionPath.split("/")[0];

        const rawDataJson = await exportCollectionPath(collectionPath, "json");
        const dataJson = normalizeExportItems(rawDataJson as unknown[]);

        const validItems = dataJson.filter((item): item is Record<string, unknown> & { id: string } => typeof item.id === 'string' && item.id.length > 0);
        const dataJsonMap:Map<string, object> = new Map(validItems.map(item => [item.id, item]));
        const citekeys = validItems.map(item => item.id);
        const citekeysNotEmpty = citekeys.filter(item => item !== null && item !== undefined && item !== '');
        const citekeysUnique:Set<string> = new Set(citekeysNotEmpty)

        const collData:CollectionData = {'path': collectionPath, 'library': libraryName, 'bibliography': [...citekeysUnique], 'data': dataJsonMap, 'annotationsMap': new Map()};
        
        return collData;

    } catch (e) {
        console.error(e);
        const empty = emptyCollectionData(collectionPath, collectionPath.split("/")[0] ?? '');
        empty.error = e as Error;
        return empty;
    }

};

function overlapsExistingRange(ranges: CitationMention[], from: number, to: number): boolean {
    return ranges.some((range) => Math.max(range.from, from) < Math.min(range.to, to));
}

function normalizeMentionCitekey(raw: string): string {
    return raw.trim().replace(/^@+/, '');
}

export function extractCitationMentions(textString: string): CitationMention[] {
    try {
        const ranges: CitationMention[] = [];

        const pushMention = (citekey: string, format: CitationMentionFormat, from: number, to: number) => {
            const normalized = normalizeMentionCitekey(citekey);
            if (!normalized) return;
            if (overlapsExistingRange(ranges, from, to)) return;
            ranges.push({
                citekey: normalized,
                format,
                from,
                to,
            });
        };

        const wikilinkRe = /\[\[@([A-Za-z0-9_.:-]+)\]\]/g;
        let match: RegExpExecArray | null;
        while ((match = wikilinkRe.exec(textString)) !== null) {
            pushMention(match[1], 'wikilink', match.index, match.index + match[0].length);
        }

        const pandocRe = /\[@([A-Za-z0-9_.:-]+)(?:\s*;\s*@([A-Za-z0-9_.:-]+))*\]/g;
        while ((match = pandocRe.exec(textString)) !== null) {
            const block = match[0];
            const blockStart = match.index;
            const innerRe = /@([A-Za-z0-9_.:-]+)/g;
            let innerMatch: RegExpExecArray | null;
            while ((innerMatch = innerRe.exec(block)) !== null) {
                const mentionStart = blockStart + innerMatch.index;
                const mentionEnd = mentionStart + innerMatch[0].length;
                pushMention(innerMatch[1], 'pandoc', mentionStart - 1, mentionEnd + 1);
            }
        }

        const plainRe = /(^|[\s([{'"“‘])@([A-Za-z0-9_.:-]+)/g;
        while ((match = plainRe.exec(textString)) !== null) {
            const prefix = match[1] ?? '';
            const citekey = match[2] ?? '';
            const start = match.index + prefix.length;
            const end = start + citekey.length + 1;
            pushMention(citekey, 'plain', start, end);
        }

        ranges.sort((a, b) => a.from - b.from || a.to - b.to);
        return ranges;
    } catch (e) {
        console.error(e);
        return [];
    }
}

export function citationsInText(textString:string):string[] {
    try {
        const mentions = extractCitationMentions(textString);
        const citekeysUnique = new Set(mentions.map((mention) => mention.citekey));
        return [...citekeysUnique];
    } catch (e) {
        console.error(e);
        return [];
    }
}

export async function processCollectionAndCitations(collectionPath:string, fileTextContent:string):Promise<CollectionData>  {

    let refData:CollectionData = emptyCollectionData(collectionPath, collectionPath.split("/")[0] ?? '');
    const parsedCitations = citationsInText(fileTextContent);

    try {
        const libraryName = collectionPath.split("/")[0];

        // In library-wide mode, avoid loading/exporting the whole library just to render cited references.
        if (isLibraryScopePath(collectionPath)) {
            const uniqueCitations = [...new Set(parsedCitations)];
            if (uniqueCitations.length === 0) {
                return {
                    'path': collectionPath,
                    'library': libraryName,
                    'citations': [],
                    'bibliography': [],
                    'data': new Map(),
                    'annotationsMap': new Map()
                };
            }

            let resolvedMap = new Map<string, object>();
            try {
                const located = await locateCollection(collectionPath);
                resolvedMap = await resolveCitekeysToItems(uniqueCitations, located.libraryId) as unknown as Map<string, object>;
            } catch (_err) {
                const localResolved = await resolveCitekeysToItemsViaLocalApi(uniqueCitations, collectionPath);
                resolvedMap = localResolved as unknown as Map<string, object>;
            }
            const validCitations = uniqueCitations.filter((cite) => resolvedMap.has(cite));
            const dataJsonMap:Map<string, object> = new Map(validCitations.map((cite) => [cite, resolvedMap.get(cite) as object]));
            return {
                'path': collectionPath,
                'library': libraryName,
                'citations': validCitations,
                'bibliography': validCitations,
                'data': dataJsonMap,
                'annotationsMap': new Map()
            };
        }

        refData = await processCollection(collectionPath);

        const citekeys = Array.from(refData.data.keys())
        const matches_unique = new Set(parsedCitations.filter((item) => citekeys.includes(item)));
      
        refData['citations'] = [...matches_unique];
    
        return refData;

    } catch (e) {
        console.error(e);
        refData['error'] = e as Error;
        return refData;
    }


};

export async function processAttachmentAnnotations(collectionData:CollectionData, bibliographyMode:boolean=false):Promise<ItemAnnotationsMap> {

    const annotationsMap:ItemAnnotationsMap = new Map();

    const referenceEntries = bibliographyMode ? collectionData.bibliography : collectionData.citations;
    
    if (!referenceEntries){
        return annotationsMap;
    }

    for (const item of referenceEntries) {
        
      const itemData = collectionData.data.get(item);
      const itemObj = (itemData ?? {}) as Record<string, unknown>;
      const effectiveCiteKey = typeof itemObj['id'] === 'string' && itemObj['id'] ? itemObj['id'] : item;
      const attachmentHint = {
        itemKey: (typeof itemObj['itemKey'] === 'string' ? itemObj['itemKey'] : (typeof itemObj['zotero-key'] === 'string' ? itemObj['zotero-key'] : undefined)) as string | undefined,
        zoteroItemID: (typeof itemObj['zoteroItemID'] === 'string' ? itemObj['zoteroItemID'] : undefined) as string | undefined,
        zotero: (typeof itemObj['zotero'] === 'string' ? itemObj['zotero'] : undefined) as string | undefined,
        citekey: (typeof itemObj['id'] === 'string' ? itemObj['id'] : (typeof itemObj['citekey'] === 'string' ? itemObj['citekey'] : item)) as string | undefined,
        doi: (typeof itemObj['DOI'] === 'string' ? itemObj['DOI'] : undefined) as string | undefined,
        title: (typeof itemObj['title'] === 'string' ? itemObj['title'] : undefined) as string | undefined,
      };

      let itemAttachmentsAll:Attachment[] = [];
      try {
        const rawAttachments = await attachments(effectiveCiteKey, collectionData.library, attachmentHint);
        itemAttachmentsAll = Array.isArray(rawAttachments) ? rawAttachments as Attachment[] : [];
      } catch (_err) {
        continue;
      }
            
      const chosenAttachment = preferredAttachment(itemAttachmentsAll);

      if (chosenAttachment){
        const linkAttachment = chosenAttachment.open;
        const linkAnnotations = Array.isArray(chosenAttachment.annotations) ? chosenAttachment.annotations : [];

        const citekey:CiteKey = item;

        const reference:Reference = {citekey: citekey, library: collectionData.library}

        const data:ItemAnnotationsData = {reference: reference, parentUri: linkAttachment, annotations: linkAnnotations, itemData: itemData ?? {}};

        annotationsMap.set(citekey, data)
        
      } else {
        const fallbackUrl = zoteroUriFromItemData(itemObj) || ((typeof itemObj['URL'] === 'string' && itemObj['URL'])
            ? itemObj['URL']
            : (typeof itemObj['id'] === 'string' && itemObj['id'].startsWith('http') ? itemObj['id'] : ''));
        if (fallbackUrl) {
            const reference:Reference = {citekey: item, library: collectionData.library}
            const data:ItemAnnotationsData = {reference: reference, parentUri: fallbackUrl as string, annotations: [], itemData: itemData ?? {}};
            annotationsMap.set(item, data);
        }
      }

    }

    collectionData.annotationsMap = annotationsMap;

    return collectionData.annotationsMap;
    
}

export async function processCollectionAttachmentAnnotations(collectionData:CollectionData):Promise<ItemAnnotationsMap> {

    const annotationsMap:ItemAnnotationsMap = new Map();

    const referenceEntries = collectionData.bibliography;
    
    for (const item of referenceEntries) {
        
      const itemData = collectionData.data.get(item);
      const itemObj = (itemData ?? {}) as Record<string, unknown>;
      const effectiveCiteKey = typeof itemObj['id'] === 'string' && itemObj['id'] ? itemObj['id'] : item;
      const attachmentHint = {
        itemKey: (typeof itemObj['itemKey'] === 'string' ? itemObj['itemKey'] : (typeof itemObj['zotero-key'] === 'string' ? itemObj['zotero-key'] : undefined)) as string | undefined,
        zoteroItemID: (typeof itemObj['zoteroItemID'] === 'string' ? itemObj['zoteroItemID'] : undefined) as string | undefined,
        zotero: (typeof itemObj['zotero'] === 'string' ? itemObj['zotero'] : undefined) as string | undefined,
        citekey: (typeof itemObj['id'] === 'string' ? itemObj['id'] : (typeof itemObj['citekey'] === 'string' ? itemObj['citekey'] : item)) as string | undefined,
        doi: (typeof itemObj['DOI'] === 'string' ? itemObj['DOI'] : undefined) as string | undefined,
        title: (typeof itemObj['title'] === 'string' ? itemObj['title'] : undefined) as string | undefined,
      };

      let itemAttachmentsAll:Attachment[] = [];
      try {
        const rawAttachments = await attachments(effectiveCiteKey, collectionData.library, attachmentHint);
        itemAttachmentsAll = Array.isArray(rawAttachments) ? rawAttachments as Attachment[] : [];
      } catch (_err) {
        continue;
      }
            
      const chosenAttachment = preferredAttachment(itemAttachmentsAll);

      if (chosenAttachment){
        const linkAttachment = chosenAttachment.open;
        const linkAnnotations = Array.isArray(chosenAttachment.annotations) ? chosenAttachment.annotations : [];

        const citekey:CiteKey = item;

        const reference:Reference = {citekey: citekey, library: collectionData.library}

        const data:ItemAnnotationsData = {reference: reference, parentUri: linkAttachment, annotations: linkAnnotations, itemData: itemData ?? {}};

        annotationsMap.set(citekey, data)
        
      } else {
        const fallbackUrl = zoteroUriFromItemData(itemObj) || ((typeof itemObj['URL'] === 'string' && itemObj['URL'])
            ? itemObj['URL']
            : (typeof itemObj['id'] === 'string' && itemObj['id'].startsWith('http') ? itemObj['id'] : ''));
        if (fallbackUrl) {
            const reference:Reference = {citekey: item, library: collectionData.library}
            const data:ItemAnnotationsData = {reference: reference, parentUri: fallbackUrl as string, annotations: [], itemData: itemData ?? {}};
            annotationsMap.set(item, data);
        }
      }

    }

    collectionData.annotationsMap = annotationsMap;

    return collectionData.annotationsMap;

}
