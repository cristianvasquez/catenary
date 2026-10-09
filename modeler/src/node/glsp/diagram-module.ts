// GLSP diagram module for views. The graph is generated from the shared store; see view-session.ts.

import {
    ActionHandlerConstructor, BindingTarget, CommandStack, DiagramConfiguration, DiagramModule, EdgeTypeHint, GEdge,
    GGraph, GLabel, GModelElementConstructor, GModelFactory, GNode, InstanceMultiBinding, ModelState,
    DefaultModelState, OperationHandlerConstructor, PaletteItem, ServerLayoutKind, ShapeTypeHint, SourceModelStorage, ToolPaletteItemProvider,
    TriggerNodeCreationAction, UndoRedoActionHandler
} from '@eclipse-glsp/server';
import { inject, injectable, interfaces } from '@theia/core/shared/inversify';
import { TYPES } from '@catenary/model';
import { DIAGRAM_TYPE } from '../../common/protocol';
import {
    ChangeBoundsHandler, CreateCardHandler, CreateGroupHandler, CreateNoteHandler, CreateShapeHandler, CreateValueSetHandler, CutHandler, DeleteHandler,
    PasteHandler, RequestClipboardDataHandler, SetCardScaleHandler, SetShowHiddenHandler, StoreUndoRedoHandler
} from './handlers';
import { LayoutViewHandler } from './layout';
import { StoreCommandStack, ViewGModelFactory, ViewModelStorage, ViewSession, ViewState } from './view-session';

@injectable()
export class ViewDiagramConfiguration implements DiagramConfiguration {
    get typeMapping(): Map<string, GModelElementConstructor> {
        return new Map<string, GModelElementConstructor>([
            [TYPES.GRAPH, GGraph],
            [TYPES.CARD, GNode],
            [TYPES.GROUP, GNode],
            [TYPES.NOTE, GNode],
            [TYPES.VIEW_REFERENCE, GNode],
            [TYPES.COLLECTION, GNode],
            [TYPES.RELATION, GEdge],
            [TYPES.BUNDLE, GEdge],
            [TYPES.ARROW, GEdge],
            [TYPES.NAME, GLabel],
            [TYPES.SHAPE, GNode],
            [TYPES.LEAF, GNode],
            [TYPES.ONE_OF, GNode],
            [TYPES.LOGIC, GNode],
            [TYPES.VALUESET, GNode],
            [TYPES.PROPERTY, GEdge],
            [TYPES.ALTERNATIVE, GEdge],
            [TYPES.LATENT, GEdge],
            [TYPES.TARGETING, GEdge],
            [TYPES.ROW, GLabel]
        ]);
    }

    get shapeTypeHints(): ShapeTypeHint[] {
        const hint = { repositionable: true, deletable: true, resizable: true, reparentable: false };
        return [
            { elementTypeId: TYPES.CARD, ...hint }, { elementTypeId: TYPES.GROUP, ...hint },
            { elementTypeId: TYPES.NOTE, ...hint }, { elementTypeId: TYPES.VIEW_REFERENCE, ...hint }, { elementTypeId: TYPES.COLLECTION, ...hint },
            { elementTypeId: TYPES.SHAPE, ...hint }, { elementTypeId: TYPES.VALUESET, ...hint }, { elementTypeId: TYPES.ONE_OF, ...hint },
            // An "in" box or a class pill moves freely (a move places it); Del removes its lines too. A private pill does not move (no
            // placement). Logical constraints are drawn at the middle of their member lines (ADR 0014).
            { elementTypeId: TYPES.LEAF, repositionable: true, deletable: true, resizable: false, reparentable: false },
            { elementTypeId: TYPES.LOGIC, repositionable: false, deletable: true, resizable: false, reparentable: false }
        ];
    }

    get edgeTypeHints(): EdgeTypeHint[] {
        return [{
            elementTypeId: TYPES.RELATION, repositionable: false, deletable: true, routable: false,
            sourceElementTypeIds: [TYPES.CARD], targetElementTypeIds: [TYPES.CARD]
        }, {
            elementTypeId: TYPES.BUNDLE, repositionable: false, deletable: false, routable: false,
            sourceElementTypeIds: [TYPES.CARD, TYPES.COLLECTION], targetElementTypeIds: [TYPES.CARD, TYPES.COLLECTION]
        }, {
            elementTypeId: TYPES.ARROW, repositionable: false, deletable: true, routable: false,
            sourceElementTypeIds: [TYPES.CARD, TYPES.GROUP, TYPES.NOTE, TYPES.VIEW_REFERENCE, TYPES.COLLECTION, TYPES.SHAPE, TYPES.LEAF, TYPES.ONE_OF, TYPES.VALUESET],
            targetElementTypeIds: [TYPES.CARD, TYPES.GROUP, TYPES.NOTE, TYPES.VIEW_REFERENCE, TYPES.COLLECTION, TYPES.SHAPE, TYPES.LEAF, TYPES.ONE_OF, TYPES.VALUESET]
        }, {
            elementTypeId: TYPES.PROPERTY, repositionable: false, deletable: true, routable: false,
            sourceElementTypeIds: [TYPES.SHAPE], targetElementTypeIds: [TYPES.SHAPE, TYPES.LEAF, TYPES.ONE_OF, TYPES.VALUESET]
        }, {
            elementTypeId: TYPES.ALTERNATIVE, repositionable: false, deletable: false, routable: false,
            sourceElementTypeIds: [TYPES.ONE_OF], targetElementTypeIds: [TYPES.SHAPE, TYPES.VALUESET, TYPES.LEAF]
        }];
    }

    /** No server layout: positions come from the view graph. ELK runs only on request (LayoutViewHandler). */
    layoutKind = ServerLayoutKind.MANUAL;
    needsClientLayout = false;
    animatedUpdate = false;
}

/**
 * Palette: one group "Model" with Scheme (concept scheme; Collection in its menu), Shape and one item per class of the shapes (instance
 * tools), then the group "View" with the marks of the view (Group, Note). Relations, attributes and properties are made on the cards.
 */
@injectable()
export class ShapesPaletteProvider extends ToolPaletteItemProvider {
    @inject(ViewState) protected readonly session: ViewState;

    getItems(): PaletteItem[] {
        const classes: PaletteItem[] = this.session.store.meta.classes.map((c, i) => ({
            id: `class-${i}`, label: c.name, sortString: 'C' + String(i).padStart(4, '0'), icon: 'symbol-class',
            actions: [TriggerNodeCreationAction.create(TYPES.CARD, { args: { classIri: c.iri } })]
        }));
        return [
            {
                id: 'palette-model', label: 'Model', sortString: 'A', actions: [], icon: 'symbol-class', children: [
                    { id: 'scheme', label: 'Scheme', sortString: 'A', icon: 'symbol-enum', actions: [TriggerNodeCreationAction.create(TYPES.VALUESET, { args: { kind: 'scheme' } })] },
                    { id: 'collection', label: 'Collection', sortString: 'AB', icon: 'symbol-array', actions: [TriggerNodeCreationAction.create(TYPES.VALUESET, { args: { kind: 'collection' } })] },
                    { id: 'node-shape', label: 'Shape', sortString: 'B', icon: 'symbol-ruler', actions: [TriggerNodeCreationAction.create(TYPES.SHAPE)] },
                    ...classes
                ]
            },
            {
                id: 'layout', label: 'View', sortString: 'B', actions: [], icon: 'layout', children: [
                    { id: 'group', label: 'Group', sortString: 'A', icon: 'symbol-namespace', actions: [TriggerNodeCreationAction.create(TYPES.GROUP)] },
                    { id: 'note', label: 'Note', sortString: 'B', icon: 'note', actions: [TriggerNodeCreationAction.create(TYPES.NOTE)] }
                ]
            }
        ];
    }
}

@injectable()
export class ViewDiagramModule extends DiagramModule {
    readonly diagramType = DIAGRAM_TYPE;

    protected override configure(bind: interfaces.Bind, unbind: interfaces.Unbind, isBound: interfaces.IsBound, rebind: interfaces.Rebind): void {
        super.configure(bind, unbind, isBound, rebind);
        bind(ViewState).toSelf().inSingletonScope();
        bind(ViewSession).toSelf().inSingletonScope();
    }

    protected bindDiagramConfiguration(): BindingTarget<DiagramConfiguration> { return ViewDiagramConfiguration; }
    protected bindSourceModelStorage(): BindingTarget<SourceModelStorage> { return ViewModelStorage; }
    protected bindModelState(): BindingTarget<ModelState> { return DefaultModelState; }
    protected bindGModelFactory(): BindingTarget<GModelFactory> { return ViewGModelFactory; }
    protected override bindCommandStack(): BindingTarget<CommandStack> { return StoreCommandStack; }
    protected override bindToolPaletteItemProvider(): BindingTarget<ToolPaletteItemProvider> { return ShapesPaletteProvider; }

    protected override configureActionHandlers(binding: InstanceMultiBinding<ActionHandlerConstructor>): void {
        super.configureActionHandlers(binding);
        binding.rebind(UndoRedoActionHandler, StoreUndoRedoHandler);
        binding.add(SetShowHiddenHandler);
        binding.add(SetCardScaleHandler);
        binding.add(RequestClipboardDataHandler);
        binding.add(LayoutViewHandler);
    }

    protected override configureOperationHandlers(binding: InstanceMultiBinding<OperationHandlerConstructor>): void {
        super.configureOperationHandlers(binding);
        binding.add(CreateCardHandler);
        binding.add(CreateGroupHandler);
        binding.add(CreateNoteHandler);
        binding.add(CreateShapeHandler);
        binding.add(CreateValueSetHandler);
        binding.add(ChangeBoundsHandler);
        binding.add(DeleteHandler);
        binding.add(CutHandler);
        binding.add(PasteHandler);
    }
}
