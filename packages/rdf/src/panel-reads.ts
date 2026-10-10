import { ExplorerContext, ExplorerScope, elementInFile, explorerPort, iriOf } from './explorer';
import { shapeTargetChoices as readShapeTargetChoices } from './link-choices';
import { dataPredicates, knownClasses as readKnownClasses, viewDescription as readViewDescription } from './queries';
import { filesOfElement, textTargets } from './selection';
// Frontend query host: request-scoped reads and the existing panel rules. No shared Doc (ADR 0012).

import {
    ActionTarget, AppearanceData, Choices, DeletePlan, Doc, ElementProperties, ElementRow, ExplorerDrag, ExplorerPage, ExplorerPath, ExplorerRow, FileContent, GestureInfo,
    MetamodelInfo, ModelQueries, ModelSelection, NewLabelKind, Occurrence, OpenTarget, OutlineNode, Problem, RelationChoices, SearchHit, Selected, SelectionActions,
    SelectionLinks, ShapesModel, Showing, View, ViewGesture, appearanceData, deletePlan, elementOfId, elementRows, emptySelected, knownPredicates, neighborChoices, newLabel,
    occurrence, relationChoices, shapeSourceChoices, showing, viewGesture
} from '@catenary/model';
import { absolutePath, pathKey } from 'rdf-files';
import { ActionContext, placements, selectionActions } from './actions';
import { copyAsRdf, prepareRdfPaste } from './clipboard';
import { explorerChildren, explorerElements, explorerPaths, explorerSearch } from './explorer';
import { enclosingWorkspace, positionIn } from './files';
import { ModelGraph } from './graph';
import { elementId, elementTerm } from './ids';
import { LinkChoices, linkChoices } from './link-choices';
import { fileContent } from './loader';
import { OutlineSelection, outline } from './outline';
import { filesOfSubject } from './placement';
import { properties } from './properties';
import { formData, hiddenRelations, selectionLinks, viewCounts } from './queries';
import { reportProblems } from './report-read';
import { DocScope, instanceLabels } from './scoped-doc';
import { search } from './search';
import { selected } from './selection';
import { Settings } from './settings';
import { Metamodel, formShapes } from './shapes';
import { ShapesIndex } from './shapes-read';
import { rdf, termKey } from './terms';
import { viewLabels } from './view-read';

/** State and request reads supplied by the coordinator. No edit or file queue access. */
export interface ReadContext {
    graph: ModelGraph;
    metamodel: Metamodel;
    settings?: Settings;
    folder: string;
    file?: string;
    shapesIndex(): ShapesIndex;
    scoped(scope: DocScope): Doc;
    viewDoc(view: string): Doc;
    explorerScopes(): Map<string, ExplorerScope>;
}

/** Frontend reads. The coordinator supplies state and retains event-keyed caches. */
export class PanelReads implements ModelQueries {
    constructor(private readonly ctx: ReadContext) {}
    private get graph() { return this.ctx.graph; }
    private get metamodel() { return this.ctx.metamodel; }
    private get settings() { return this.ctx.settings; }
    private get folder() { return this.ctx.folder; }
    private get file() { return this.ctx.file; }
    private get meta(): MetamodelInfo {
        const { source, classes, schemes, concepts } = this.metamodel;
        return { source, classes, schemes, concepts };
    }
    private shapesIndex() { return this.ctx.shapesIndex(); }
    private scoped(scope: DocScope) { return this.ctx.scoped(scope); }
    private viewDoc(view: string) { return this.ctx.viewDoc(view); }
    prepareRdfPaste(text: string, mediaType?: string) { return prepareRdfPaste(text, mediaType); }

    copyAsRdf(viewId: string, ids: string[]) { return copyAsRdf(this.graph, viewId, ids); }

    private explorerContext(): ExplorerContext {
        const reads = this;
        return { g: this.graph, get idx() { return reads.shapesIndex(); }, settings: this.settings, folder: this.folder,
            get scopes() { return reads.ctx.explorerScopes(); } };
    }
    knownClasses() { return readKnownClasses(this.graph, this.metamodel); }
    viewDescription(viewId: string) { return readViewDescription(this.graph, this.file, viewId); }
    shapeTargetChoices(viewId: string, from: string) { return readShapeTargetChoices(this.graph, this.viewDoc(viewId), viewId, from); }

    formData(instanceId: string): string {
        const t = elementTerm(instanceId);
        return t?.termType === 'NamedNode' ? formData(this.graph, t, this.metamodel) : '';
    }

    explorerChildren(key?: string, file?: string, offset?: number): ExplorerPage {
        return this.file ? explorerChildren(explorerPort(this.explorerContext(), file), key ?? undefined, offset ?? 0) : { rows: [], total: 0 };
    }

    explorerSearch(text: string, file?: string): ExplorerRow[] {
        return this.file ? explorerSearch(explorerPort(this.explorerContext(), file), text) : [];
    }

    explorerPaths(id: string, file?: string): ExplorerPath[] {
        const iri = iriOf(this.shapesIndex(), id);
        return this.file && iri ? explorerPaths(explorerPort(this.explorerContext(), file), iri) : [];
    }

    explorerElements(key: string, file?: string): string[] {
        return this.file ? explorerElements(explorerPort(this.explorerContext(), file), key).filter(id => !file || elementInFile(this.explorerContext(), id, file)) : [];
    }

    explorerDrag(selection: ExplorerDrag): string[] {
        return [...new Set([...selection.ids, ...selection.folders.flatMap(key => this.explorerElements(key, selection.file))])]
            .filter(id => !selection.file || elementInFile(this.explorerContext(), id, selection.file));
    }

    properties(id?: string): ElementProperties | undefined {
        if (!this.file) return undefined;
        const view = id === undefined ? undefined : viewCounts(this.graph, this.shapesIndex(), id);
        if (view) return view;
        const idx = this.shapesIndex();
        const ws = this.settings!;
        return properties({
            g: this.graph, meta: this.metamodel, idx, fileOf: t => filesOfSubject(this.graph, t)[0],
            importedFiles: q => ws.filesOfQuad(q).filter(f => ws.isImported(f))
        }, id);
    }

    outline(viewId: string, selection?: OutlineSelection): OutlineNode[] {
        if (!this.file) return [];
        const shapes = this.shapesIndex().model;
        return outline({ g: this.graph, meta: this.metamodel, shapes }, viewId, selection);
    }

    problems(): Problem[] {
        if (!this.file) return [];
        const idx = this.shapesIndex();
        return reportProblems(this.graph, this.metamodel, t => idx.byTerm.get(termKey(t)));
    }

    search(): SearchHit[] {
        if (!this.file) return [];
        return search({ g: this.graph, shapes: this.shapesIndex() });
    }

    viewLabels(): Record<string, string> {
        return this.file ? viewLabels(this.graph) : {};
    }

    viewGesture(viewId: string, gesture: ViewGesture): GestureInfo {
        const doc = this.scoped({ elements: gestureElements(gesture), selectionViews: [viewId] });
        return viewGesture(doc, this.meta, doc.views[viewId], gesture);
    }

    appearance(viewId: string, ids: string[]): AppearanceData | undefined {
        const doc = this.scoped({ elements: ids, selectionViews: [viewId] }), view = doc.views[viewId];
        return view && { ...appearanceData(doc, this.meta, view, ids), hidden: hiddenRelations(this.graph, viewId, this.meta) };
    }

    occurrence(ids: string[], view?: string): Occurrence | undefined {
        return this.file ? occurrence(this.scoped({ elements: ids, selectionViews: [view], showing: true }), this.meta, ids, view) : undefined;
    }

    showing(id: string): Showing {
        return showing(this.scoped({ elements: [id], showing: true }), id);
    }

    links(ids: string[], view?: string): SelectionLinks {
        const idx = this.shapesIndex();
        return selectionLinks(this.graph, idx, this.scoped({ elements: ids, selectionViews: [view] }), this.metamodel, ids, view);
    }

    shapesText(): string {
        return formShapes(this.metamodel).toString();
    }

    async openTargets(id: string): Promise<OpenTarget[]> {
        if (!this.file) return [];
        const files = filesOfElement(this.graph, () => this.shapesIndex(), this.settings, id);
        const sources = await Promise.all(files.map(async (path): Promise<OpenTarget> => ({ presentation: 'Source', path, ...await positionIn(path, textTargets(this.shapesIndex(), id)) })));
        const models = files.filter(f => this.explorerPaths(id, f).length).map((path): OpenTarget => ({ presentation: 'Model', path }));
        const shown = this.showing(id);
        const canvases = shown.isView
            ? [{ presentation: 'Canvas' as const, view: id, label: this.viewLabels()[id] ?? id }]
            : shown.views.map(v => ({ presentation: 'Canvas' as const, view: v.id, label: v.label, box: v.box }));
        return [...sources, ...models, ...canvases];
    }

    selectionActions(target: ActionTarget): SelectionActions {
        if (!this.file) return { actions: [], items: [], cards: [] };
        const doc = this.scoped({ elements: target.ids, selectionViews: [target.view] });
        const ctx: ActionContext = {
            g: this.graph, shapes: this.shapesIndex().model,
            placements: placements(this.graph, this.shapesIndex().byTerm, target.ids.map(id => elementOfId(target.view ? doc.views[target.view] : undefined, id))),
            doc,
            viewOf: v => doc.views[v],
            filesOf: id => filesOfElement(this.graph, () => this.shapesIndex(), this.settings, id)
        };
        return selectionActions(ctx, target);
    }

    selected(selection: ModelSelection): Selected {
        return this.file ? selected(this.graph, this.shapesIndex(), selection) : emptySelected();
    }

    view(viewId: string, ids?: string[]): View | undefined {
        return this.file ? (ids ? this.scoped({ elements: ids, selectionViews: [viewId] }) : this.viewDoc(viewId)).views[viewId] : undefined;
    }

    shapes(): ShapesModel {
        return this.shapesIndex().model;
    }

    deletePlan(ids: string[]): DeletePlan {
        return deletePlan(this.scoped({ elements: ids, neighbors: true, showing: true }), this.metamodel, ids);
    }

    relationChoices(source: string, target: string): RelationChoices | undefined {
        return relationChoices(this.scoped({ elements: [source, target] }), this.metamodel, source, target);
    }

    neighborChoices(viewId: string, from: string, dir: 'out' | 'in'): Choices | undefined {
        return neighborChoices(this.scoped({ elements: [from], neighbors: true, views: [viewId] }), this.metamodel, viewId, from, dir);
    }

    shapeSourceChoices(viewId: string, from: string): Choices | undefined {
        return shapeSourceChoices(this.viewDoc(viewId), viewId, from);
    }

    linkChoices(dir: 'out' | 'in', from: string, viewId: string, text?: string): LinkChoices {
        if (!this.file) return undefined;
        return linkChoices({ g: this.graph, meta: this.metamodel, shapes: this.shapesIndex().model }, dir, from, viewId, text);
    }

    newLabel(kind: NewLabelKind, opts?: { classIri?: string; view?: string; base?: string }): string {
        const doc = this.scoped({ views: [opts?.view] });
        if (kind === 'instance' || kind === 'concept') {
            for (const [iri, label] of instanceLabels(this.graph)) {
                if (!label.startsWith('unnamed ')) continue;
                const id = elementId(rdf.namedNode(iri));
                doc.instances[id] = { id, label, uri: iri, types: [], fields: {} };
            }
        }
        return newLabel(doc, this.metamodel, kind, opts);
    }

    knownPredicates(): { iri: string; where: string }[] {
        const doc = this.scoped({});
        const id = 'data';
        doc.instances[id] = { id, label: '', uri: '', types: [], fields: Object.fromEntries(dataPredicates(this.graph).map(p => [p, []])) };
        return knownPredicates(doc, this.metamodel);
    }

    memberOptions(viewId: string, collection: string): string[] {
        const view = this.viewDoc(viewId).views[viewId];
        const members = new Set(view?.boxes.find(b => b.kind === 'collection' && b.id === collection)?.kind === 'collection'
            ? (view.boxes.find(b => b.id === collection) as { members: string[] }).members : []);
        return [...new Set([...instanceLabels(this.graph)].filter(([iri]) => !members.has(elementId(rdf.namedNode(iri)))).map(([, label]) => label))].sort();
    }

    instancesNamed(text: string): string[] {
        return [...instanceLabels(this.graph)].filter(([iri, label]) => label === text || iri === text).map(([iri]) => elementId(rdf.namedNode(iri)));
    }

    elementRows(ids: string[], viewId?: string): ElementRow[] {
        return elementRows(this.scoped({ elements: ids, selectionViews: [viewId] }), this.metamodel, ids, viewId);
    }

    unplaced(ids: string[]): string[] {
        const doc = this.scoped({ elements: ids, showing: true });
        const views = Object.values(doc.views);
        return ids.filter(id => doc.instances[id] ? !views.some(v => v.boxes.some(b => b.kind === 'card' && b.element === id))
            : !!doc.relations[id] && !views.some(v => v.edges.some(e => e.id && e.relation === id)));
    }

    async fileContent(file: string): Promise<FileContent> {
        const p = absolutePath(file);
        const c = await fileContent(p);
        const views = c.views.map(v => ({ id: elementId(rdf.namedNode(v.iri)), label: v.label }));
        const own = c.views.some(v => { const f = this.settings?.viewFile(v.iri); return !!f && pathKey(f.path) === pathKey(p); });
        const workspaceFile = views.length ? (own && this.settings ? this.settings.path : await enclosingWorkspace(p)) : undefined;
        return { workspace: c.workspace, views, ...(workspaceFile ? { workspaceFile } : {}), ...(c.error ? { error: c.error } : {}) };
    }

}

/** The elements of a gesture whose records `viewGesture` reads: its source, relation, row or property, and its candidate cards. */
function gestureElements(g: ViewGesture): string[] {
    switch (g.kind) {
        case 'reconnect': return [g.relation, ...g.cards];
        case 'link': case 'linkIn': case 'shapeLink': case 'shapeLinkIn': return [g.source, ...g.cards, ...g.boxes];
        case 'arrow': return [g.source, ...g.boxes];
        case 'row': return [g.row, ...g.cards];
        case 'logic': return [g.from, ...g.ids];
        case 'target': return [g.property, ...g.cards];
        case 'element': return [g.id];
        case 'broader': return [];
    }
}
