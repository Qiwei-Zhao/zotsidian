export type SourceManagedBlockSection =
  | 'metadata'
  | 'annotations'
  | 'related'
  | 'references'
  | 'citations'
  | 'discourse';

export type SourceManagedAnnotationItemMarkers = {
  begin: string;
  importBegin: string;
  importEnd: string;
  notesBegin: string;
  notesEnd: string;
  end: string;
};

export type SourceManagedBlockMarkers = {
  begin: string;
  end: string;
};

const SOURCE_MANAGED_BLOCK_HEADINGS: Record<SourceManagedBlockSection, string> = {
  metadata: '## Metadata',
  annotations: '## Annotations',
  related: '## Related',
  references: '## References',
  citations: '## Citations',
  discourse: '## Discourse',
};

export function getSourceManagedBlockHeading(section: SourceManagedBlockSection): string {
  return SOURCE_MANAGED_BLOCK_HEADINGS[section];
}

export function getSourceManagedBlockMarkers(section: SourceManagedBlockSection): SourceManagedBlockMarkers {
  return {
    begin: `%% zotsidian:begin section=${section} %%`,
    end: `%% zotsidian:end section=${section} %%`,
  };
}

export function getLegacySourceManagedBlockMarkers(section: SourceManagedBlockSection): SourceManagedBlockMarkers {
  return {
    begin: `<!-- zotsidian:begin section=${section} -->`,
    end: `<!-- zotsidian:end section=${section} -->`,
  };
}

export function wrapSourceManagedBlock(section: SourceManagedBlockSection, content: string): string {
  const normalized = (content || '').trim();
  return normalized || getSourceManagedBlockHeading(section);
}

export function getSourceManagedAnnotationItemMarkers(key: string): SourceManagedAnnotationItemMarkers {
  const normalizedKey = (key || '').trim();
  return {
    begin: `%% zotsidian:item-begin section=annotations key=${normalizedKey} %%`,
    importBegin: '%% zotsidian:item-import-begin %%',
    importEnd: '%% zotsidian:item-import-end %%',
    notesBegin: '%% zotsidian:item-notes-begin %%',
    notesEnd: '%% zotsidian:item-notes-end %%',
    end: '%% zotsidian:item-end %%',
  };
}

export function getLegacySourceManagedAnnotationItemMarkers(key: string): SourceManagedAnnotationItemMarkers {
  const normalizedKey = (key || '').trim();
  return {
    begin: `<!-- zotsidian:item-begin section=annotations key=${normalizedKey} -->`,
    importBegin: '<!-- zotsidian:item-import-begin -->',
    importEnd: '<!-- zotsidian:item-import-end -->',
    notesBegin: '<!-- zotsidian:item-notes-begin -->',
    notesEnd: '<!-- zotsidian:item-notes-end -->',
    end: '<!-- zotsidian:item-end -->',
  };
}

export function wrapSourceManagedAnnotationItem(
  key: string,
  importedContent: string,
  notesContent: string
): string {
  const markers = getSourceManagedAnnotationItemMarkers(key);
  const imported = (importedContent || '').trim();
  const notes = (notesContent || '').trim();
  return [
    markers.begin,
    markers.importBegin,
    imported,
    markers.importEnd,
    markers.notesBegin,
    notes,
    markers.notesEnd,
    markers.end,
  ].filter((part) => part !== '').join('\n');
}
