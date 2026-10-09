import {
    GLSPTheiaFrontendModule, ContainerContext, TheiaContextMenuServiceFactory, DiagramConfiguration, DiagramWidgetFactory, createDiagramWidgetFactory, registerDiagramManager
} from '@eclipse-glsp/theia-integration';
import { GLSPDiagramLanguage } from '@eclipse-glsp/theia-integration/lib/common';
import {
    FrontendApplicationContribution, KeybindingContext, LabelProviderContribution, OpenHandler, Widget, WidgetFactory, createTreeContainer,
    bindViewContribution
} from '@theia/core/lib/browser';
import { interfaces } from '@theia/core/shared/inversify';
import { TabBarToolbarContribution } from '@theia/core/lib/browser/shell/tab-bar-toolbar';
import { MenuContribution, ResourceResolver } from '@theia/core';
import { FilterContribution } from '@theia/core/lib/common/contribution-filter';
import { HiddenContributions } from './hidden-contributions';
import { PreferenceContribution } from '@theia/core/lib/common/preferences';
import { ServiceConnectionProvider } from '@theia/core/lib/browser/messaging/service-connection-provider';
import { PropertyViewWidgetProvider } from '@theia/property-view/lib/browser/property-view-widget-provider';
import { CONTRIBUTION_ID, DIAGRAM_TYPE, MODEL_SERVICE_PATH, ModelService } from '../common/protocol';
import { ModelActions } from './actions';
import { ActionService } from './action-service';
import { ActionContribution } from './action-commands';
import { FollowUp } from './follow-up';
import { WaitingContextMenuService } from './action-menus';
import { CommandContribution } from '@theia/core';
import { KeybindingContribution } from '@theia/core/lib/browser';
import { NoteEditor } from './notes/note-editor';
import { ViewNotesEditors } from './notes/view-notes';
import { ViewNotesResolver } from './notes/view-notes-resource';
import { NoteMarkdown } from './notes/note-markdown';
import { CanvasInteractions } from './diagram/canvas';
import { ViewClipboard } from './diagram/clipboard';
import { ViewDiagramConfiguration } from './diagram/diagram-configuration';
import { ViewDiagramWidget } from './diagram/view-widget';
import { FontPreferences, fontPreferences } from './diagram/font-preferences';
import { EdgePreferences, edgePreferences } from './diagram/edge-preferences';
import { LayoutPreferences, layoutPreferences } from './diagram/layout-preferences';
import { ModelerMenus } from './menus';
import { OUTLINE_CONTEXT_MENU, ViewOutline, ViewOutlineWidget } from './outline';
import { OutlineViewWidgetFactory } from '@theia/outline-view/lib/browser/outline-view-widget';
import { OutlineViewTreeModel } from '@theia/outline-view/lib/browser/outline-view-tree-model';
import { OutlineDecoratorService, OutlineTreeDecorator } from '@theia/outline-view/lib/browser/outline-decorator-service';
import { bindRootContributionProvider } from '@theia/core/lib/common/contribution-provider';
import { ViewDiagramManager, ViewEditors, ViewLabels } from './diagram/view-editors';
import { MarkdownExport } from './diagram/markdown-export';
import { InsertView } from './insert-view';
import { ViewHistory } from './diagram/view-history';
import { ExplorerFocusContext, ModelContribution, CatenaryFileOpenHandler } from './commands';
import { EXPLORER_CONTEXT_MENU, FILE_EXPLORER_ID, ModelExplorerWidget, ModelTree } from './explorer/model-explorer';
import { RecentWorkspaces } from './explorer/recent-workspaces';
import { FileKindsDecorator } from './file-kinds-decorator';
import { NavigatorTreeDecorator } from '@theia/navigator/lib/browser/navigator-decorator-service';
import { ModelFrontend, ModelServiceProxy, ModelWatcher } from './model-client';
import { CliBridge, CliContainer } from './cli-bridge';
import { SelectionModel } from './selection-model';
import { RdfLanguageContribution } from './rdf-language-contribution';
import { DiagramSelectionSync } from './diagram/selection-sync';
import { ElementLabelProvider, ElementOpenHandler, ModelProblemWidget, ModelProblems } from './problems';
import { ProblemWidget } from '@theia/markers/lib/browser/problem/problem-widget';
import { PROBLEM_TREE_PROPS } from '@theia/markers/lib/browser/problem/problem-container';
import { ProblemTree, ProblemTreeModel } from '@theia/markers/lib/browser/problem/problem-tree-model';
import { MarkerOptions } from '@theia/markers/lib/browser/marker-tree';
import { APPEARANCE_ID, AppearanceContribution, AppearanceWidget } from './properties/appearance-widget';
import { LINKS_CONTEXT_MENU, LINKS_ID, LinksContribution, LinksFocusContext, LinksWidget } from './properties/links-widget';
import { SEARCH_ID, SearchContribution, SearchWidget } from './search/search-widget';
import { WORKSPACE_SETTINGS_ID, WorkspaceSettingsWidget } from './prefixes/workspace-settings';
import { WorkspaceFileQuestion } from './prefixes/workspace-placement';
import { ModelPropertiesProvider, ModelPropertiesWidget } from './properties/properties-widget';
import { SidePanelSizes } from './side-panel-sizes';
import '../../css/modeler.css';

export const ViewLanguage: GLSPDiagramLanguage = {
    contributionId: CONTRIBUTION_ID,
    label: 'View Editor',
    providerName: 'Catenary',
    diagramType: DIAGRAM_TYPE,
    fileExtensions: [],
    iconClass: 'codicon codicon-type-hierarchy'
};

export class ModelerFrontendModule extends GLSPTheiaFrontendModule {
    readonly diagramLanguage = ViewLanguage;
    protected override enableLayoutCommands = false;

    bindDiagramConfiguration(context: ContainerContext): void {
        context.bind(DiagramConfiguration).to(ViewDiagramConfiguration);
    }

    override bindDiagramWidgetFactory(context: ContainerContext): void {
        context.bind(ViewDiagramWidget).toSelf();
        context.bind(DiagramWidgetFactory).toDynamicValue(ctx => createDiagramWidgetFactory(ctx, this.diagramLanguage.diagramType, ViewDiagramWidget));
    }

    override configureDiagramManager(context: ContainerContext): void {
        context.bind(ViewDiagramManager).toSelf().inSingletonScope();
        registerDiagramManager(context.bind, ViewDiagramManager, false);
    }

    override configure({ bind, rebind }: ContainerContext): void {
        /** One instance of `cls`, also bound to each of `services`. */
        const single = <T>(cls: interfaces.Newable<T>, ...services: interfaces.ServiceIdentifier[]) => {
            bind(cls).toSelf().inSingletonScope();
            services.forEach(s => bind(s).toService(cls));
        };
        /**
         * A widget of a WidgetFactory: a new instance for each creation (not a singleton). Closing a tab disposes its widget, and the
         * WidgetManager then asks the factory again: a singleton would give back the disposed widget (an empty tab).
         */
        const transient = <T>(cls: interfaces.Newable<T>) => bind(cls).toSelf();
        const widgetFactory = (id: string, cls: interfaces.ServiceIdentifier<Widget>) =>
            bind(WidgetFactory).toDynamicValue(ctx => ({ id, createWidget: () => ctx.container.get(cls) })).inSingletonScope();

        // Backend connection
        single(ModelWatcher);
        bind(ModelServiceProxy).toDynamicValue(ctx => {
            const watcher = ctx.container.get(ModelWatcher);
            return ServiceConnectionProvider.createProxy<ModelService>(ctx.container, MODEL_SERVICE_PATH, watcher);
        }).inSingletonScope();
        single(ModelFrontend);
        single(SelectionModel);
        single(ModelActions);
        // The actions on the selection (spec/ui-manifest.hs §4): the backend answers which apply; one command each, in every menu.
        single(ActionService);
        single(FollowUp);
        single(ActionContribution, CommandContribution, MenuContribution, KeybindingContribution);
        // The context menu of a view editor opens after the actions of the selection are known.
        rebind(TheiaContextMenuServiceFactory).toFactory(ctx => () => {
            const container = ctx.container.createChild();
            container.bind(WaitingContextMenuService).toSelf().inSingletonScope();
            return container.get(WaitingContextMenuService);
        });
        single(NoteMarkdown);
        single(NoteEditor);
        single(ViewNotesEditors, FrontendApplicationContribution);
        single(ViewNotesResolver, ResourceResolver);

        // RDF source editors
        single(RdfLanguageContribution, FrontendApplicationContribution);

        // View editors
        single(ViewLabels);
        single(ViewEditors, FrontendApplicationContribution);
        single(MarkdownExport);
        single(InsertView);
        single(ViewHistory, FrontendApplicationContribution);
        single(DiagramSelectionSync, FrontendApplicationContribution);
        single(CanvasInteractions, FrontendApplicationContribution);
        single(ViewClipboard, FrontendApplicationContribution);
        single(ViewOutline, FrontendApplicationContribution);
        // The Outline widget of @theia/outline-view, with the context menu of the actions and multiple selection.
        rebind(OutlineViewWidgetFactory).toFactory(ctx => () => {
            const child = createTreeContainer(ctx.container, {
                props: { expandOnlyOnExpansionToggleClick: true, search: true, multiSelect: true, contextMenuPath: OUTLINE_CONTEXT_MENU },
                widget: ViewOutlineWidget, model: OutlineViewTreeModel, decoratorService: OutlineDecoratorService
            });
            bindRootContributionProvider(child, OutlineTreeDecorator);
            return child.get(ViewOutlineWidget);
        });
        single(FontPreferences, FrontendApplicationContribution);
        bind(PreferenceContribution).toConstantValue(fontPreferences);
        single(EdgePreferences, FrontendApplicationContribution);
        bind(PreferenceContribution).toConstantValue(edgePreferences);
        single(LayoutPreferences, FrontendApplicationContribution);
        bind(PreferenceContribution).toConstantValue(layoutPreferences);

        // One Model document per file. The files use the Theia navigator.
        // The explorer owns one backend filter. Theia's type-ahead search only highlights loaded rows.
        const explorerProps = { contextMenuPath: EXPLORER_CONTEXT_MENU, multiSelect: true, search: false, globalSelection: true, expandOnlyOnExpansionToggleClick: false };
        single(RecentWorkspaces);
        single(SidePanelSizes);
        bind(ModelExplorerWidget).toDynamicValue(ctx => createTreeContainer(ctx.container, {
            props: explorerProps, widget: ModelExplorerWidget, tree: ModelTree
        }).get(ModelExplorerWidget));
        bind(WidgetFactory).toDynamicValue(ctx => ({ id: FILE_EXPLORER_ID, createWidget: (options: { file: string }) => {
            const widget = ctx.container.get(ModelExplorerWidget);
            widget.configure(options.file);
            return widget;
        } })).inSingletonScope();
        single(ModelContribution, FrontendApplicationContribution, CommandContribution, MenuContribution, KeybindingContribution, TabBarToolbarContribution);
        single(ModelerMenus, MenuContribution);
        single(ExplorerFocusContext, KeybindingContext);
        single(CatenaryFileOpenHandler, OpenHandler);
        // ADR 0004: no Run and Debug, no Testing.
        bind(FilterContribution).to(HiddenContributions).inSingletonScope();
        single(FileKindsDecorator, NavigatorTreeDecorator);

        // Search panel
        transient(SearchWidget);
        widgetFactory(SEARCH_ID, SearchWidget);
        bindViewContribution(bind, SearchContribution);

        // Prefixes of the workspace
        transient(WorkspaceSettingsWidget);
        widgetFactory(WORKSPACE_SETTINGS_ID, WorkspaceSettingsWidget);
        single(WorkspaceFileQuestion, FrontendApplicationContribution);

        // Properties, Appearance and Links of the selected element
        single(ModelPropertiesWidget);
        single(ModelPropertiesProvider, PropertyViewWidgetProvider);
        transient(AppearanceWidget);
        widgetFactory(APPEARANCE_ID, AppearanceWidget);
        bindViewContribution(bind, AppearanceContribution);
        bind(LinksWidget).toDynamicValue(ctx => createTreeContainer(ctx.container, {
            props: { contextMenuPath: LINKS_CONTEXT_MENU, multiSelect: true, globalSelection: false },
            widget: LinksWidget
        }).get(LinksWidget));
        widgetFactory(LINKS_ID, LinksWidget);
        bindViewContribution(bind, LinksContribution);
        bind(TabBarToolbarContribution).toService(LinksContribution);
        single(LinksFocusContext, KeybindingContext);

        // Problems, labels, status bar
        single(ModelProblems, FrontendApplicationContribution);
        single(ElementLabelProvider, LabelProviderContribution);
        single(ElementOpenHandler, OpenHandler);
        // The Problems widget of @theia/markers with the context menu of the actions and drag to a view (problems.ts).
        rebind(ProblemWidget).toDynamicValue(ctx => {
            const child = createTreeContainer(ctx.container, { tree: ProblemTree, widget: ModelProblemWidget, model: ProblemTreeModel, props: PROBLEM_TREE_PROPS });
            child.bind(MarkerOptions).toConstantValue({ kind: 'problem' });
            return child.get(ModelProblemWidget);
        });

        // Command-line interface (scripts/catenary.mjs)
        bind(CliContainer).toDynamicValue(ctx => ctx.container).inSingletonScope();
        single(CliBridge, FrontendApplicationContribution);
    }
}

export default new ModelerFrontendModule();
