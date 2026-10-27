package common.rest

import com.atlassian.jira.component.ComponentAccessor
import com.atlassian.jira.config.properties.APKeys
import com.atlassian.jira.issue.customfields.option.Option
import com.atlassian.jira.issue.fields.CustomField
import com.atlassian.jira.issue.fields.config.FieldConfig
import com.atlassian.jira.issue.fields.config.FieldConfigScheme
import com.atlassian.jira.issue.fields.layout.field.FieldLayout
import com.atlassian.jira.issue.fields.layout.field.FieldLayoutItem
import com.atlassian.jira.issue.fields.layout.field.FieldLayoutScheme
import com.atlassian.jira.issue.fields.layout.field.FieldLayoutSchemeEntity
import com.atlassian.jira.issue.fields.screen.FieldScreen
import com.atlassian.jira.issue.fields.screen.FieldScreenLayoutItem
import com.atlassian.jira.issue.fields.screen.FieldScreenScheme
import com.atlassian.jira.issue.fields.screen.FieldScreenSchemeItem
import com.atlassian.jira.issue.fields.screen.FieldScreenTab
import com.atlassian.jira.issue.fields.screen.issuetype.IssueTypeScreenScheme
import com.atlassian.jira.issue.fields.screen.issuetype.IssueTypeScreenSchemeEntity
import com.atlassian.jira.issue.issuetype.IssueType
import com.atlassian.jira.issue.link.IssueLinkTypeManager
import com.atlassian.jira.issue.operation.IssueOperation
import com.atlassian.jira.issue.operation.IssueOperations
import com.atlassian.jira.issue.operation.ScreenableIssueOperation
import com.atlassian.jira.issue.security.IssueSecuritySchemeManager
import com.atlassian.jira.project.Project
import com.atlassian.jira.security.roles.ProjectRole
import com.atlassian.jira.security.roles.ProjectRoleManager
import com.atlassian.jira.security.roles.RoleActor
import com.atlassian.jira.util.BuildUtilsInfo
import com.atlassian.jira.workflow.AssignableWorkflowScheme
import com.atlassian.jira.workflow.JiraWorkflow
import com.atlassian.jira.workflow.WorkflowUtil
import com.onresolve.scriptrunner.runner.rest.common.CustomEndpointDelegate
import groovy.json.JsonOutput
import groovy.json.JsonSlurper
import groovy.transform.BaseScript

import jakarta.servlet.http.HttpServletRequest
import jakarta.ws.rs.core.MultivaluedMap
import jakarta.ws.rs.core.Response
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.nio.charset.StandardCharsets
import java.time.Duration
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

/**
 * Jira configuration snapshot for the jira-config skill. Read-only: it changes nothing.
 * Deploy as a ScriptRunner REST endpoint (file in the Script Root, e.g. common/rest/JiraConfigSnapshotEndpoint.groovy).
 * Jira 11: JAX-RS and servlet are jakarta.* only; javax.* does not resolve.
 *
 * Open in a browser as an administrator; jira-config-<timestamp>.zip is downloaded:
 *   <baseUrl>/rest/scriptrunner/latest/custom/jiraConfigSnapshot
 *   <baseUrl>/rest/scriptrunner/latest/custom/jiraConfigSnapshot?exclude=Category1,Category2
 *   <baseUrl>/rest/scriptrunner/latest/custom/jiraConfigSnapshot?skip=jsm,assets
 *
 * The zip holds:
 *  - Java API: projects (lead, roles with members, components, schemes), issue types, workflow schemes,
 *    XML of all workflows and drafts, field configurations, screens, screen schemes, fields with contexts and options,
 *    permission, notification and issue security schemes, global permissions, lookups (statuses, priorities,
 *    resolutions, link types, categories, roles, events).
 *  - REST from inside the server under the session of whoever opened the link: JSM (request types with forms,
 *    portal groups, queues, SLAs), the Assets structure (schemas, object types, attributes, statuses; no objects),
 *    the ScriptRunner report (GET /rest/scriptrunner/latest/script/export/?isActive=false: the zip of the UI export
 *    button plus disabled workflow functions and behaviours) as scriptrunner-report.zip, and all Automation rules
 *    (GET /rest/cb-automation/latest/project/GLOBAL/rule/export) as automation-rules.json.
 * skip: jsm, assets, scriptrunner, automation, drafts, options; leave a section out when the export takes too long.
 * meta.json carries baseUrl: unpack.py maps it to the local instance folder.
 * Access: the groups list of the endpoint below; set it to your administrator group.
 */
@BaseScript CustomEndpointDelegate delegate

jiraConfigSnapshot(httpMethod: 'GET', groups: ['jira-administrators']) { MultivaluedMap queryParams, String body, HttpServletRequest request ->
  Set<String> excluded = splitParam(queryParams.getFirst('exclude') as String)
  Set<String> skipped = splitParam(queryParams.getFirst('skip') as String).collect { String name -> name.toLowerCase() } as Set<String>
  try {
    Map payload = collectSnapshot(excluded, skipped, restContext(request))
    String stamp = new Date().format('yyyyMMdd-HHmmss')
    ByteArrayOutputStream buffer = new ByteArrayOutputStream()
    ZipOutputStream zip = new ZipOutputStream(buffer, StandardCharsets.UTF_8)
    try {
      writeSnapshotZip(zip, payload)
    } finally {
      zip.close()
    }
    return Response.ok(buffer.toByteArray())
      .type('application/zip')
      .header('Content-Disposition', "attachment; filename=\"jira-config-${stamp}.zip\"".toString())
      .build()
  } catch (Exception snapshotError) {
    StringWriter trace = new StringWriter()
    snapshotError.printStackTrace(new PrintWriter(trace))
    return Response.serverError()
      .type('text/plain; charset=UTF-8')
      .entity(trace.toString())
      .build()
  }
}

/** Collects the whole snapshot into one Map. Per-object failures go to errors instead of failing the export. */
Map collectSnapshot(Set<String> excludedCategories, Set<String> skipped, Map rest) {
  final projectManager = ComponentAccessor.projectManager
  final projectRoleManager = ComponentAccessor.getComponent(ProjectRoleManager)
  final projectComponentManager = ComponentAccessor.projectComponentManager
  final permissionSchemeManager = ComponentAccessor.permissionSchemeManager
  final notificationSchemeManager = ComponentAccessor.notificationSchemeManager
  final issueSecuritySchemeManager = ComponentAccessor.getComponent(IssueSecuritySchemeManager)
  final optionsManager = ComponentAccessor.optionsManager
  final constantsManager = ComponentAccessor.constantsManager
  final issueTypeSchemeManager = ComponentAccessor.issueTypeSchemeManager
  final workflowSchemeManager = ComponentAccessor.workflowSchemeManager
  final workflowManager = ComponentAccessor.workflowManager
  final issueTypeScreenSchemeManager = ComponentAccessor.issueTypeScreenSchemeManager
  final fieldScreenSchemeManager = ComponentAccessor.fieldScreenSchemeManager
  final fieldScreenManager = ComponentAccessor.fieldScreenManager
  final fieldLayoutManager = ComponentAccessor.fieldLayoutManager
  final customFieldManager = ComponentAccessor.customFieldManager
  final fieldManager = ComponentAccessor.fieldManager

  /** Renderer that field configurations treat as the default; it is not written as an exception. */
  final String DEFAULT_RENDERER = 'jira-text-renderer'

  final List<Map> errors = []
  final List<Map> projectNodes = []
  final Map<Long, Map> issueTypeSchemesById = new LinkedHashMap<Long, Map>()
  final Map<Long, Set<String>> projectKeysByIssueTypeScheme = new LinkedHashMap<Long, Set<String>>()
  final Map<Long, Set<String>> projectKeysByWorkflowScheme = new LinkedHashMap<Long, Set<String>>()
  final Map<Long, Set<String>> projectKeysByIssueTypeScreenScheme = new LinkedHashMap<Long, Set<String>>()
  final Map<Long, Set<String>> projectKeysByScreenScheme = new LinkedHashMap<Long, Set<String>>()

  final List<Project> allProjects = (projectManager.projectObjects ?: [])
    .toList()
    .sort { Project project -> project.key ?: '' }

  final List<Project> projects = allProjects.findAll { Project project ->
    String categoryName = project.projectCategoryObject?.name
    return !excludedCategories.contains(categoryName)
  }

  projects.each { Project project ->
    try {
      FieldConfigScheme issueTypeScheme = issueTypeSchemeManager.getConfigScheme(project)
      AssignableWorkflowScheme workflowScheme = workflowSchemeManager.getWorkflowSchemeObj(project)
      IssueTypeScreenScheme issueTypeScreenScheme = issueTypeScreenSchemeManager.getIssueTypeScreenScheme(project)
      def fieldConfigurationScheme = fieldLayoutManager.getFieldConfigurationScheme(project)
      Long issueTypeSchemeId = issueTypeScheme?.id as Long

      addProjectKey(projectKeysByIssueTypeScheme, issueTypeSchemeId, project.key)
      addProjectKey(projectKeysByWorkflowScheme, workflowScheme?.id as Long, project.key)
      addProjectKey(projectKeysByIssueTypeScreenScheme, issueTypeScreenScheme?.id as Long, project.key)
      rememberIssueTypeScheme(issueTypeSchemesById, errors, issueTypeSchemeManager, issueTypeScheme)

      Collection<IssueType> issueTypes = issueTypeSchemeManager.getIssueTypesForProject(project) as Collection<IssueType>
      List<Map> issueTypeNodes = []
      (issueTypes ?: [])
        .toList()
        .sort { IssueType issueType -> issueType?.name ?: '' }
        .each { IssueType issueType ->
          try {
            String workflowName = workflowScheme?.getActualWorkflow(issueType.id)
            boolean explicitMapping = workflowScheme?.mappings?.containsKey(issueType.id) ?: false
            FieldScreenScheme screenScheme = issueTypeScreenScheme?.getEffectiveFieldScreenScheme(issueType)
            addProjectKey(projectKeysByScreenScheme, screenScheme?.id as Long, project.key)
            issueTypeNodes << [
              id             : issueType.id,
              name           : issueType.name,
              subTask        : issueType.subTask,
              workflowName   : workflowName,
              workflowMapping: explicitMapping ? 'explicit' : 'default',
              screenScheme   : ref(screenScheme?.id, screenScheme?.name),
              screens        : [
                create: screenNode(screenScheme, IssueOperations.CREATE_ISSUE_OPERATION),
                edit  : screenNode(screenScheme, IssueOperations.EDIT_ISSUE_OPERATION),
                view  : screenNode(screenScheme, IssueOperations.VIEW_ISSUE_OPERATION),
              ],
            ]
          } catch (Exception issueTypeError) {
            errors << [scope: 'projectIssueType', key: "${project.key}:${issueType?.id}".toString(), message: issueTypeError.message]
          }
        }

      projectNodes << [
        key                     : project.key,
        name                    : project.name,
        id                      : project.id,
        category                : project.projectCategoryObject?.name,
        projectType             : project.projectTypeKey?.key,
        archived                : project.archived,
        lead                    : userRef(project.leadUserKey),
        assigneeType            : project.assigneeType,
        issueTypeScheme         : ref(issueTypeScheme?.id, issueTypeScheme?.name),
        workflowScheme          : ref(workflowScheme?.id, workflowScheme?.name),
        issueTypeScreenScheme   : ref(issueTypeScreenScheme?.id, issueTypeScreenScheme?.name),
        fieldConfigurationScheme: ref(fieldConfigurationScheme?.id, fieldConfigurationScheme?.name),
        permissionScheme        : projectSchemeRef(permissionSchemeManager, project, errors, 'permissionScheme'),
        notificationScheme      : projectSchemeRef(notificationSchemeManager, project, errors, 'notificationScheme'),
        issueSecurityScheme     : projectSchemeRef(issueSecuritySchemeManager, project, errors, 'issueSecurityScheme'),
        roles                   : projectRoleNodes(projectRoleManager, project, errors),
        components              : projectComponentNodes(projectComponentManager, project, errors),
        issueTypes              : issueTypeNodes,
      ]
    } catch (Exception projectError) {
      errors << [scope: 'project', key: project.key, message: projectError.message]
    }
  }

  List<Map> issueTypeSchemeNodes = issueTypeSchemesById.values()
    .toList()
    .sort { Map scheme -> scheme.name ?: '' }
  issueTypeSchemeNodes.each { Map scheme ->
    scheme.projectKeys = sortedKeys(projectKeysByIssueTypeScheme, scheme.id as Long)
  }

  final List<AssignableWorkflowScheme> workflowSchemes = (workflowSchemeManager.assignableSchemes ?: [])
    .toList()
    .sort { AssignableWorkflowScheme scheme -> scheme?.name ?: '' }

  final Set<String> referencedWorkflowNames = new LinkedHashSet<String>()
  final List<Map> workflowSchemeNodes = []
  workflowSchemes.each { AssignableWorkflowScheme scheme ->
    try {
      String defaultWorkflow = scheme.actualDefaultWorkflow
      if (defaultWorkflow) {
        referencedWorkflowNames.add(defaultWorkflow)
      }
      List<Map> mappings = []
      (scheme.mappings ?: [:]).each { String issueTypeId, String workflowName ->
        if (!issueTypeId) {
          return
        }
        if (workflowName) {
          referencedWorkflowNames.add(workflowName)
        }
        IssueType mappedType = constantsManager.getIssueType(issueTypeId)
        mappings << [
          issueTypeId  : issueTypeId,
          issueTypeName: mappedType?.name,
          workflowName : workflowName,
        ]
      }
      mappings.sort { Map mapping -> mapping.issueTypeName ?: mapping.issueTypeId ?: '' }
      workflowSchemeNodes << [
        id             : scheme.id,
        name           : scheme.name,
        projectKeys    : sortedKeys(projectKeysByWorkflowScheme, scheme.id as Long),
        defaultWorkflow: defaultWorkflow,
        mappings       : mappings,
      ]
    } catch (Exception schemeError) {
      errors << [scope: 'workflowScheme', key: scheme?.id, message: schemeError.message]
    }
  }

  final Map<String, JiraWorkflow> workflowsByName = new LinkedHashMap<String, JiraWorkflow>()
  (workflowManager.workflows ?: []).each { JiraWorkflow workflow ->
    if (workflow?.name) {
      workflowsByName.put(workflow.name, workflow)
    }
  }

  final List<String> workflowNames = new LinkedHashSet<String>(workflowsByName.keySet().findAll { String name ->
    JiraWorkflow workflow = workflowsByName.get(name)
    return workflow?.active || referencedWorkflowNames.contains(name)
  }).toList()
  referencedWorkflowNames.each { String name ->
    if (!workflowNames.contains(name)) {
      workflowNames.add(name)
    }
  }
  workflowNames.sort()

  final List<Map> workflowNodes = []
  workflowNames.each { String workflowName ->
    JiraWorkflow workflow = workflowsByName.get(workflowName)
    List<String> statuses = []
    if (workflow != null) {
      try {
        statuses = (workflow.linkedStatusObjects ?: [])
          .collect { status -> status?.name }
          .findAll { name -> name }
          .unique()
          .sort()
      } catch (Exception statusError) {
        errors << [scope: 'workflow', key: workflowName, message: statusError.message]
      }
    }
    workflowNodes << [
      name              : workflowName,
      active            : workflow == null ? null : workflow.active,
      referencedByScheme: referencedWorkflowNames.contains(workflowName),
      statuses          : statuses,
    ]
  }

  final List<Map> issueTypeScreenSchemeNodes = []
  (issueTypeScreenSchemeManager.issueTypeScreenSchemes ?: [])
    .toList()
    .sort { IssueTypeScreenScheme scheme -> scheme?.name ?: '' }
    .each { IssueTypeScreenScheme scheme ->
      try {
        List<Map> mappings = (scheme.entities ?: [])
          .toList()
          .sort { IssueTypeScreenSchemeEntity entity -> entity?.issueType?.name ?: '' }
          .collect { IssueTypeScreenSchemeEntity entity ->
            IssueType issueType = entity.issueType
            [
              issueTypeId  : entity.issueTypeId ?: issueType?.id,
              issueTypeName: issueType?.name ?: (entity.issueTypeId ? null : '(default)'),
              screenScheme : ref(entity.fieldScreenScheme?.id, entity.fieldScreenScheme?.name),
            ]
          }
        issueTypeScreenSchemeNodes << [
          id         : scheme.id,
          name       : scheme.name,
          projectKeys: sortedKeys(projectKeysByIssueTypeScreenScheme, scheme.id as Long),
          mappings   : mappings,
        ]
      } catch (Exception schemeError) {
        errors << [scope: 'issueTypeScreenScheme', key: scheme?.id, message: schemeError.message]
      }
    }

  final List<Map> screenSchemeNodes = []
  (fieldScreenSchemeManager.fieldScreenSchemes ?: [])
    .toList()
    .sort { FieldScreenScheme scheme -> scheme?.name ?: '' }
    .each { FieldScreenScheme scheme ->
      try {
        List<Map> screens = (scheme.fieldScreenSchemeItems ?: [])
          .toList()
          .sort { FieldScreenSchemeItem item -> operationLabel(item?.issueOperation) }
          .collect { FieldScreenSchemeItem item ->
            [
              operation: operationLabel(item.issueOperation),
              id       : item.fieldScreen?.id,
              name     : item.fieldScreen?.name,
            ]
          }
        screenSchemeNodes << [
          id         : scheme.id,
          name       : scheme.name,
          projectKeys: sortedKeys(projectKeysByScreenScheme, scheme.id as Long),
          screens    : screens,
        ]
      } catch (Exception schemeError) {
        errors << [scope: 'screenScheme', key: scheme?.id, message: schemeError.message]
      }
    }

  final List<Map> screenNodes = []
  (fieldScreenManager.fieldScreens ?: [])
    .toList()
    .sort { FieldScreen screen -> screen?.name ?: '' }
    .each { FieldScreen screen ->
      try {
        List<Map> tabs = (screen.tabs ?: []).collect { FieldScreenTab tab ->
          List<Map> fields = (tab.fieldScreenLayoutItems ?: []).collect { FieldScreenLayoutItem item ->
            [
              fieldId : item.fieldId,
              name    : item.orderableField?.name,
              position: item.position,
            ]
          }
          [
            id      : tab.id,
            name    : tab.name,
            position: tab.position,
            fields  : fields,
          ]
        }
        screenNodes << [
          id  : screen.id,
          name: screen.name,
          tabs: tabs,
        ]
      } catch (Exception screenError) {
        errors << [scope: 'screen', key: screen?.id, message: screenError.message]
      }
    }

  final List<Map> fieldLayoutNodes = []
  try {
    List<FieldLayout> layouts = []
    FieldLayout defaultLayout = fieldLayoutManager.fieldLayout
    if (defaultLayout != null) {
      layouts << defaultLayout
    }
    (fieldLayoutManager.editableFieldLayouts ?: []).each { FieldLayout layout ->
      boolean alreadyAdded = layouts.any { FieldLayout existing ->
        if (layout?.id == null) {
          return existing?.id == null
        }
        return existing?.id == layout.id
      }
      if (alreadyAdded) {
        return
      }
      layouts << layout
    }
    layouts.sort { FieldLayout layout -> layout?.name ?: '' }.each { FieldLayout layout ->
      try {
        List<Map> items = []
        (layout.fieldLayoutItems ?: []).each { FieldLayoutItem item ->
          String renderer = item.rendererType
          if (!item.hidden && !item.required && (renderer == null || renderer == DEFAULT_RENDERER)) {
            return
          }
          def field = item.orderableField
          items << [
            fieldId : field?.id,
            name    : field?.name,
            hidden  : item.hidden,
            required: item.required,
            renderer: renderer,
          ]
        }
        fieldLayoutNodes << [
          id                : layout.id,
          name              : layout.name,
          exceptionItemsOnly: true,
          items             : items,
        ]
      } catch (Exception layoutError) {
        errors << [scope: 'fieldLayout', key: layout?.id, message: layoutError.message]
      }
    }
  } catch (Exception layoutsError) {
    errors << [scope: 'fieldLayouts', key: '', message: layoutsError.message]
  }

  final List<Map> fieldLayoutSchemeNodes = []
  (fieldLayoutManager.fieldLayoutSchemes ?: [])
    .toList()
    .sort { FieldLayoutScheme scheme -> scheme?.name ?: '' }
    .each { FieldLayoutScheme scheme ->
      try {
        List<Map> mappings = (scheme.entities ?: [])
          .toList()
          .sort { FieldLayoutSchemeEntity entity -> entity?.issueType?.name ?: '' }
          .collect { FieldLayoutSchemeEntity entity ->
            [
              issueTypeId  : entity.issueTypeId,
              issueTypeName: entity.issueType?.name ?: (entity.issueTypeId ? null : '(default)'),
              fieldLayoutId: entity.fieldLayoutId,
            ]
          }
        List<String> projectKeys = (scheme.projectsUsing ?: [])
          .collect { project -> project?.key }
          .findAll { key -> key }
          .sort()
        fieldLayoutSchemeNodes << [
          id         : scheme.id,
          name       : scheme.name,
          projectKeys: projectKeys,
          mappings   : mappings,
        ]
      } catch (Exception schemeError) {
        errors << [scope: 'fieldLayoutScheme', key: scheme?.id, message: schemeError.message]
      }
    }

  final List<Map> customFieldNodes = []
  (customFieldManager.customFieldObjects ?: [])
    .toList()
    .sort { CustomField field -> field?.name ?: '' }
    .each { CustomField field ->
      try {
        List<Map> contexts = (field.configurationSchemes ?: []).collect { FieldConfigScheme scheme ->
          Map context = [
            id           : scheme.id,
            name         : scheme.name,
            global       : scheme.global,
            allProjects  : scheme.allProjects,
            allIssueTypes: scheme.allIssueTypes,
            projects     : (scheme.associatedProjectObjects ?: []).collect { project ->
              [id: project?.id, key: project?.key]
            },
            issueTypes   : (scheme.associatedIssueTypes ?: []).findAll { issueType -> issueType }.collect { issueType ->
              [id: issueType.id, name: issueType.name]
            },
          ]
          if (!skipped.contains('options')) {
            List<Map> options = contextOptions(optionsManager, scheme, errors, field.id)
            if (options) {
              context.options = options
            }
          }
          return context
        }
        customFieldNodes << [
          id      : field.id,
          name    : field.name,
          type    : field.customFieldType?.key,
          typeName: field.customFieldType?.name,
          contexts: contexts,
        ]
      } catch (Exception fieldError) {
        errors << [scope: 'customField', key: field?.id, message: fieldError.message]
      }
    }

  final List<Map> systemFieldNodes = []
  try {
    (fieldManager.orderableFields ?: [])
      .findAll { field -> !(field instanceof CustomField) }
      .sort { field -> field?.name ?: '' }
      .each { field ->
        systemFieldNodes << [id: field.id, name: field.name]
      }
  } catch (Exception systemFieldsError) {
    errors << [scope: 'systemFields', key: '', message: systemFieldsError.message]
  }

  final List<Map> workflowXmlNodes = []
  final List<Map> workflowDraftXmlNodes = []
  Set<String> usedXmlNames = new LinkedHashSet<String>()
  Set<String> usedDraftXmlNames = new LinkedHashSet<String>()
  try {
    (workflowManager.workflows ?: [])
      .findAll { JiraWorkflow workflow -> workflow?.descriptor != null }
      .sort { JiraWorkflow workflow -> workflow?.name ?: '' }
      .each { JiraWorkflow workflow ->
        try {
          workflowXmlNodes << [
            name  : workflow.name,
            active: workflow.active,
            file  : uniqueXmlName(workflow.name, usedXmlNames),
            xml   : workflowXml(workflow),
          ]
        } catch (Exception xmlError) {
          errors << [scope: 'workflowXml', key: workflow?.name, message: xmlError.message]
        }
        if (skipped.contains('drafts') || !workflow.active) {
          return
        }
        try {
          JiraWorkflow draft = workflowManager.getDraftWorkflow(workflow.name)
          if (draft?.descriptor != null) {
            workflowDraftXmlNodes << [
              name: workflow.name,
              file: uniqueXmlName(workflow.name, usedDraftXmlNames),
              xml : workflowXml(draft),
            ]
          }
        } catch (Exception draftError) {
          errors << [scope: 'workflowDraftXml', key: workflow?.name, message: draftError.message]
        }
      }
  } catch (Exception workflowsError) {
    errors << [scope: 'workflowXml', key: '', message: workflowsError.message]
  }

  final Map globals = collectGlobals(errors)
  final List<Map> permissionSchemeNodes = schemeNodes(permissionSchemeManager, 'permissionScheme', errors)
  final List<Map> notificationSchemeNodes = schemeNodes(notificationSchemeManager, 'notificationScheme', errors)
  final List<Map> issueSecuritySchemeNodes = issueSecuritySchemeNodes(issueSecuritySchemeManager, errors)
  final List<Map> serviceDeskNodes = skipped.contains('jsm') ? [] : collectServiceDesks(rest, errors)
  final List<Map> assetsSchemaNodes = skipped.contains('assets') ? [] : collectAssetsSchemas(rest, errors)
  final byte[] scriptRunnerReport = skipped.contains('scriptrunner') ? null : (restPart(errors, 'scriptrunner', 'script/export') {
    restGetBytes(rest, '/rest/scriptrunner/latest/script/export/?isActive=false')
  } as byte[])
  final byte[] automationRules = skipped.contains('automation') ? null : (restPart(errors, 'automation', 'rule/export') {
    restGetBytes(rest, '/rest/cb-automation/latest/project/GLOBAL/rule/export')
  } as byte[])

  return [
    meta                  : [
      generatedAt              : new Date().format('yyyy-MM-dd HH:mm:ss'),
      timezone                 : 'server',
      layout                   : 'split-v3',
      baseUrl                  : ComponentAccessor.applicationProperties.getString(APKeys.JIRA_BASEURL),
      jiraVersion              : ComponentAccessor.getComponent(BuildUtilsInfo)?.version,
      excludedProjectCategories: excludedCategories.toList().sort(),
      skippedSections          : skipped.toList().sort(),
      restBase                 : rest.workingBase,
      counts                   : [
        projects              : projectNodes.size(),
        projectsExcluded      : allProjects.size() - projects.size(),
        issueTypeSchemes      : issueTypeSchemeNodes.size(),
        workflowSchemes       : workflowSchemeNodes.size(),
        workflows             : workflowNodes.size(),
        workflowXml           : workflowXmlNodes.size(),
        workflowDraftXml      : workflowDraftXmlNodes.size(),
        issueTypeScreenSchemes: issueTypeScreenSchemeNodes.size(),
        screenSchemes         : screenSchemeNodes.size(),
        screens               : screenNodes.size(),
        fieldLayouts          : fieldLayoutNodes.size(),
        fieldLayoutSchemes    : fieldLayoutSchemeNodes.size(),
        customFields          : customFieldNodes.size(),
        systemFields          : systemFieldNodes.size(),
        permissionSchemes     : permissionSchemeNodes.size(),
        notificationSchemes   : notificationSchemeNodes.size(),
        issueSecuritySchemes  : issueSecuritySchemeNodes.size(),
        serviceDesks          : serviceDeskNodes.size(),
        requestTypes          : serviceDeskNodes.sum(0) { Map desk -> (desk.requestTypes ?: []).size() },
        assetsSchemas         : assetsSchemaNodes.size(),
        assetsObjectTypes     : assetsSchemaNodes.sum(0) { Map schema -> (schema.objectTypes ?: []).size() },
        scriptRunnerReportKb  : scriptRunnerReport == null ? null : (scriptRunnerReport.length / 1024) as long,
        automationRulesKb     : automationRules == null ? null : (automationRules.length / 1024) as long,
        errors                : errors.size(),
      ],
    ],
    projects              : projectNodes,
    issueTypeSchemes      : issueTypeSchemeNodes,
    workflowSchemes       : workflowSchemeNodes,
    workflows             : workflowNodes,
    workflowXml           : workflowXmlNodes,
    workflowDraftXml      : workflowDraftXmlNodes,
    issueTypeScreenSchemes: issueTypeScreenSchemeNodes,
    screenSchemes         : screenSchemeNodes,
    screens               : screenNodes,
    fieldLayouts          : fieldLayoutNodes,
    fieldLayoutSchemes    : fieldLayoutSchemeNodes,
    customFields          : customFieldNodes,
    systemFields          : systemFieldNodes,
    globals               : globals,
    permissionSchemes     : permissionSchemeNodes,
    notificationSchemes   : notificationSchemeNodes,
    issueSecuritySchemes  : issueSecuritySchemeNodes,
    serviceDesks          : serviceDeskNodes,
    assetsSchemas         : assetsSchemaNodes,
    scriptRunnerReport    : scriptRunnerReport,
    automationRules       : automationRules,
    errors                : errors,
  ]
}

/** Comma-separated query parameter as a set of non-empty values. */
Set<String> splitParam(String value) {
  return (value ?: '')
    .split(',')
    .collect { String name -> name.trim() }
    .findAll { String name -> name } as Set<String>
}

/** User by key: key, username, active flag. Usernames matter: keys like JIRAUSER123 say nothing. */
Map userRef(String userKey) {
  if (!userKey) {
    return null
  }
  def user = ComponentAccessor.userManager.getUserByKey(userKey)
  return [key: userKey, username: user?.username, active: user?.active]
}

/** Permission, notification or issue security scheme assigned to the project. */
Map projectSchemeRef(def schemeManager, Project project, List<Map> errors, String scope) {
  try {
    def scheme = schemeManager.getSchemeFor(project)
    return scheme == null ? null : ref(scheme.id, scheme.name)
  } catch (Exception schemeError) {
    errors << [scope: scope, key: project.key, message: schemeError.message]
    return null
  }
}

/** Project roles with their members: users and groups. */
List<Map> projectRoleNodes(ProjectRoleManager projectRoleManager, Project project, List<Map> errors) {
  List<Map> nodes = []
  (projectRoleManager.projectRoles ?: []).toList().sort { ProjectRole role -> role?.name ?: '' }.each { ProjectRole role ->
    try {
      List<Map> actors = (projectRoleManager.getProjectRoleActors(role, project)?.roleActors ?: [])
        .collect { RoleActor actor -> roleActorNode(actor) }
        .sort { Map actor -> "${actor.type} ${actor.name ?: actor.username ?: actor.key}".toString() }
      nodes << [id: role.id, name: role.name, actors: actors]
    } catch (Exception roleError) {
      errors << [scope: 'projectRole', key: "${project.key}:${role?.name}".toString(), message: roleError.message]
    }
  }
  return nodes
}

/** Role member: a group by name, a user by key with the username. */
Map roleActorNode(RoleActor actor) {
  String parameter = actor.parameter
  if (actor.type == 'atlassian-group-role-actor') {
    return [type: 'group', name: parameter]
  }
  if (actor.type == 'atlassian-user-role-actor') {
    Map user = userRef(parameter)
    return [type: 'user', key: parameter, username: user?.username, active: user?.active]
  }
  return [type: actor.type, parameter: parameter]
}

/** Project components with lead and default assignee type. */
List<Map> projectComponentNodes(def projectComponentManager, Project project, List<Map> errors) {
  try {
    return (projectComponentManager.findAllForProject(project.id) ?: [])
      .toList()
      .sort { component -> component?.name ?: '' }
      .collect { component ->
        [
          id          : component.id,
          name        : component.name,
          description : component.description,
          lead        : userRef(component.lead as String),
          assigneeType: component.assigneeType,
        ]
      }
  } catch (Exception componentError) {
    errors << [scope: 'projectComponents', key: project.key, message: componentError.message]
    return []
  }
}

/** Options of a select field context, nested for cascading selects. */
List<Map> contextOptions(def optionsManager, FieldConfigScheme scheme, List<Map> errors, String fieldId) {
  try {
    FieldConfig config = scheme.oneAndOnlyConfig
    if (config == null) {
      return []
    }
    return (optionsManager.getOptions(config) ?: []).collect { Option option -> optionNode(option) }
  } catch (Exception optionsError) {
    errors << [scope: 'fieldOptions', key: "${fieldId}:${scheme?.id}".toString(), message: optionsError.message]
    return []
  }
}

/** Field option with its child options. */
Map optionNode(Option option) {
  Map node = [id: option.optionId, value: option.value, disabled: option.disabled]
  List<Option> children = (option.childOptions ?: []) as List<Option>
  if (children) {
    node.children = children.collect { Option child -> optionNode(child) }
  }
  return node
}

/** Lookups: issue types, statuses, priorities, resolutions, link types, categories, roles, events, global permissions. */
Map collectGlobals(List<Map> errors) {
  final constantsManager = ComponentAccessor.constantsManager
  Map<String, Closure> sources = [
    issueTypes       : {
      constantsManager.allIssueTypeObjects.collect { issueType ->
        [id: issueType.id, name: issueType.name, subTask: issueType.subTask, description: issueType.description]
      }
    },
    statuses         : {
      constantsManager.statuses.collect { status ->
        [id: status.id, name: status.name, category: status.statusCategory?.key, description: status.description]
      }
    },
    priorities       : {
      constantsManager.priorities.collect { priority -> [id: priority.id, name: priority.name] }
    },
    resolutions      : {
      constantsManager.resolutions.collect { resolution ->
        [id: resolution.id, name: resolution.name, description: resolution.description]
      }
    },
    issueLinkTypes   : {
      ComponentAccessor.getComponent(IssueLinkTypeManager).issueLinkTypes.collect { linkType ->
        [id: linkType.id, name: linkType.name, outward: linkType.outward, inward: linkType.inward]
      }
    },
    projectCategories: {
      ComponentAccessor.projectManager.allProjectCategories.collect { category ->
        [id: category.id, name: category.name, description: category.description]
      }
    },
    projectRoles     : {
      ComponentAccessor.getComponent(ProjectRoleManager).projectRoles.collect { ProjectRole role ->
        [id: role.id, name: role.name, description: role.description]
      }
    },
    eventTypes       : {
      ComponentAccessor.eventTypeManager.eventTypes.collect { eventType ->
        [id: eventType.id, name: eventType.name, description: eventType.description]
      }
    },
    globalPermissions: {
      final globalPermissionManager = ComponentAccessor.globalPermissionManager
      globalPermissionManager.allGlobalPermissions.collect { permission ->
        [
          key   : permission.key,
          groups: (globalPermissionManager.getGroupNamesWithPermission(permission.globalPermissionKey) ?: []).toList().sort(),
        ]
      }
    },
  ]
  Map result = new LinkedHashMap()
  sources.each { String name, Closure source ->
    try {
      result.put(name, source.call())
    } catch (Exception globalError) {
      errors << [scope: 'globals', key: name, message: globalError.message]
      result.put(name, [])
    }
  }
  return result
}

/** Permission or notification schemes: entries "permission/event -> holder" and the projects using the scheme. */
List<Map> schemeNodes(def schemeManager, String scope, List<Map> errors) {
  final eventTypeManager = ComponentAccessor.eventTypeManager
  List<Map> nodes = []
  (schemeManager.schemeObjects ?: []).toList().sort { scheme -> scheme?.name ?: '' }.each { scheme ->
    try {
      List<Map> entries = (scheme.entities ?: []).collect { entity ->
        Map entry = holderNode(entity.type as String, entity.parameter as String)
        Object entityTypeId = entity.entityTypeId
        if (scope == 'notificationScheme') {
          entry = [eventId: entityTypeId, event: eventTypeManager.getEventType(entityTypeId as Long)?.name] + entry
        } else {
          entry = [permission: entityTypeId as String] + entry
        }
        return entry
      }
      entries.sort { Map entry -> "${entry.permission ?: entry.event ?: ''} ${entry.type} ${entry.parameter ?: ''}".toString() }
      nodes << [
        id         : scheme.id,
        name       : scheme.name,
        description: scheme.description,
        projectKeys: (schemeManager.getProjects(scheme) ?: []).collect { project -> project?.key }.findAll { key -> key }.sort(),
        entries    : entries,
      ]
    } catch (Exception schemeError) {
      errors << [scope: scope, key: scheme?.id, message: schemeError.message]
    }
  }
  return nodes
}

/** Issue security schemes: levels and their members. */
List<Map> issueSecuritySchemeNodes(IssueSecuritySchemeManager issueSecuritySchemeManager, List<Map> errors) {
  final issueSecurityLevelManager = ComponentAccessor.issueSecurityLevelManager
  List<Map> nodes = []
  (issueSecuritySchemeManager.schemeObjects ?: []).toList().sort { scheme -> scheme?.name ?: '' }.each { scheme ->
    try {
      Map<Long, List<Map>> membersByLevel = [:].withDefault { [] }
      (scheme.entities ?: []).each { entity ->
        membersByLevel[entity.entityTypeId as Long] << holderNode(entity.type as String, entity.parameter as String)
      }
      List<Map> levels = (issueSecurityLevelManager.getIssueSecurityLevels(scheme.id as Long) ?: []).collect { level ->
        [id: level.id, name: level.name, description: level.description, members: membersByLevel[level.id as Long]]
      }
      nodes << [
        id         : scheme.id,
        name       : scheme.name,
        description: scheme.description,
        projectKeys: (issueSecuritySchemeManager.getProjects(scheme) ?: []).collect { project -> project?.key }.findAll { key -> key }.sort(),
        levels     : levels,
      ]
    } catch (Exception schemeError) {
      errors << [scope: 'issueSecurityScheme', key: scheme?.id, message: schemeError.message]
    }
  }
  return nodes
}

/** Grant holder: holder type, parameter and a readable name (role, username, field). */
Map holderNode(String type, String parameter) {
  Map node = [type: type, parameter: parameter]
  if (!parameter) {
    return node
  }
  if (parameter.startsWith('customfield_')) {
    node.name = ComponentAccessor.customFieldManager.getCustomFieldObject(parameter)?.name
  } else if (type?.toLowerCase()?.contains('role') && parameter.isLong()) {
    node.name = ComponentAccessor.getComponent(ProjectRoleManager).getProjectRole(parameter as Long)?.name
  } else if (type?.toLowerCase()?.contains('user')) {
    node.name = ComponentAccessor.userManager.getUserByKey(parameter)?.username ?: ComponentAccessor.userManager.getUserByName(parameter)?.username
  }
  return node
}

/**
 * REST from inside the server under the caller's session: Cookie and Authorization are copied from the request.
 * The local Tomcat connector is tried first (no proxy); baseUrl is the fallback.
 */
Map restContext(HttpServletRequest request) {
  List<String> bases = []
  if (request != null && request.localPort > 0) {
    bases << "http://127.0.0.1:${request.localPort}${request.contextPath ?: ''}".toString()
  }
  String baseUrl = ComponentAccessor.applicationProperties.getString(APKeys.JIRA_BASEURL)
  if (baseUrl) {
    bases << baseUrl.replaceAll(/\/+$/, '')
  }
  Map<String, String> headers = [:]
  ['Cookie', 'Authorization'].each { String name ->
    String value = request?.getHeader(name)
    if (value) {
      headers.put(name, value)
    }
  }
  HttpClient client = HttpClient.newBuilder()
    .connectTimeout(Duration.ofSeconds(10))
    .followRedirects(HttpClient.Redirect.NEVER)
    .build()
  return [bases: bases, headers: headers, client: client, workingBase: null]
}

/** GET JSON through restContext. Anything but 200 throws with the status and path. */
Object restGet(Map rest, String path, Map<String, Object> params = [:]) {
  String query = params ? '?' + params.collect { String key, Object value ->
    URLEncoder.encode(key, 'UTF-8') + '=' + URLEncoder.encode(String.valueOf(value), 'UTF-8')
  }.join('&') : ''
  List<String> candidates = rest.workingBase ? [rest.workingBase as String] : (rest.bases as List<String>)
  if (!candidates) {
    throw new IllegalStateException("no REST base for ${path}")
  }
  Exception lastError = null
  for (String base : candidates) {
    try {
      HttpRequest.Builder builder = HttpRequest.newBuilder(URI.create(base + path + query))
        .timeout(Duration.ofSeconds(60))
        .header('Accept', 'application/json')
        .header('X-ExperimentalApi', 'opt-in')
        .GET()
      (rest.headers as Map<String, String>).each { String name, String value -> builder.header(name, value) }
      HttpResponse<String> response = (rest.client as HttpClient).send(builder.build(), HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8))
      if (response.statusCode() != 200) {
        throw new IllegalStateException("HTTP ${response.statusCode()} GET ${path}")
      }
      rest.workingBase = base
      return new JsonSlurper().parseText(response.body() ?: 'null')
    } catch (Exception requestError) {
      lastError = requestError
      if (rest.workingBase) {
        break
      }
    }
  }
  throw lastError
}

/** GET a binary response (zip) through the base restContext already found. */
byte[] restGetBytes(Map rest, String path) {
  if (!rest.workingBase) {
    restGet(rest, '/rest/api/2/serverInfo')
  }
  HttpRequest.Builder builder = HttpRequest.newBuilder(URI.create((rest.workingBase as String) + path))
    .timeout(Duration.ofSeconds(300))
    .GET()
  (rest.headers as Map<String, String>).each { String name, String value -> builder.header(name, value) }
  HttpResponse<byte[]> response = (rest.client as HttpClient).send(builder.build(), HttpResponse.BodyHandlers.ofByteArray())
  if (response.statusCode() != 200) {
    throw new IllegalStateException("HTTP ${response.statusCode()} GET ${path}")
  }
  return response.body()
}

/** All pages of a servicedeskapi response (values, isLastPage). */
List<Map> pagedValues(Map rest, String path, Map<String, Object> params = [:]) {
  List<Map> values = []
  int start = 0
  while (true) {
    Map page = restGet(rest, path, params + [start: start, limit: 100]) as Map
    List<Map> pageValues = (page?.values ?: []) as List<Map>
    values.addAll(pageValues)
    if (page?.isLastPage != false || pageValues.isEmpty()) {
      return values
    }
    start += pageValues.size()
  }
}

/** JSM: service desks, portal groups, request types with forms, queues, SLAs. */
List<Map> collectServiceDesks(Map rest, List<Map> errors) {
  final String sdApi = '/rest/servicedeskapi/servicedesk'
  final String sdInternal = '/rest/servicedesk/1/servicedesk'
  List<Map> desks
  try {
    desks = pagedValues(rest, sdApi)
  } catch (Exception desksError) {
    errors << [scope: 'jsm', key: '', message: desksError.message]
    return []
  }
  List<Map> nodes = []
  desks.sort { Map desk -> desk.projectKey ?: '' }.each { Map desk ->
    String deskId = desk.id as String
    String projectKey = desk.projectKey as String
    Map node = [id: deskId, projectId: desk.projectId, projectKey: projectKey, projectName: desk.projectName]
    node.requestTypeGroups = restPart(errors, 'jsmGroups', projectKey) {
      pagedValues(rest, "${sdApi}/${deskId}/requesttypegroup".toString()).collect { Map group -> [id: group.id, name: group.name] }
    }
    node.queues = restPart(errors, 'jsmQueues', projectKey) {
      pagedValues(rest, "${sdApi}/${deskId}/queue".toString()).collect { Map queue ->
        [id: queue.id, name: queue.name, jql: queue.jql, fields: queue.fields]
      }
    }
    node.slaMetrics = restPart(errors, 'jsmSla', projectKey) {
      Object data = restGet(rest, "${sdInternal}/agent/${projectKey}/sla/metrics".toString())
      return data instanceof Map ? ((data as Map).timeMetrics ?: []) : data
    }
    List<Map> requestTypes = restPart(errors, 'jsmRequestTypes', projectKey) {
      pagedValues(rest, "${sdApi}/${deskId}/requesttype".toString())
    } ?: []
    node.requestTypes = requestTypes.collect { Map requestType ->
      String requestTypeId = requestType.id as String
      String errorKey = "${projectKey}:${requestTypeId}".toString()
      [
        id         : requestTypeId,
        name       : requestType.name,
        description: requestType.description,
        helpText   : requestType.helpText,
        issueTypeId: requestType.issueTypeId,
        groupIds   : requestType.groupIds,
        visible    : restPart(errors, 'jsmRequestTypeFields', errorKey) {
          requestTypeFieldRows(restGet(rest, "${sdInternal}/${requestTypeId}/request-type-fields/visible".toString()), false)
        },
        hidden     : restPart(errors, 'jsmRequestTypeFields', errorKey) {
          requestTypeFieldRows(restGet(rest, "${sdInternal}/${requestTypeId}/request-type-fields/hidden".toString()), true)
        },
      ]
    }
    nodes << node
  }
  return nodes
}

/** Request type form fields. Values are kept for hidden fields only: they are the preset values. */
List<Map> requestTypeFieldRows(Object data, boolean withValues) {
  return ((data instanceof List ? data : []) as List<Map>).collect { Map row ->
    Map node = [
      fieldId     : row.fieldId,
      name        : row.jiraName ?: row.label ?: row.fieldId,
      label       : row.label,
      description : row.description,
      sdRequired  : row.sdRequired,
      jiraRequired: row.jiraRequired,
    ]
    if (withValues) {
      node.values = row.values
    }
    return node
  }
}

/** Assets structure: schemas, object types, attributes, statuses. Objects are not exported. */
List<Map> collectAssetsSchemas(Map rest, List<Map> errors) {
  final String insightApi = '/rest/insight/1.0'
  List<Map> schemas
  try {
    Object data = restGet(rest, "${insightApi}/objectschema/list".toString())
    schemas = ((data instanceof Map ? (data as Map).objectschemas : data) ?: []) as List<Map>
  } catch (Exception schemasError) {
    errors << [scope: 'assets', key: '', message: schemasError.message]
    return []
  }
  return schemas.sort { Map schema -> schema.name ?: '' }.collect { Map schema ->
    String schemaId = schema.id as String
    List<Map> objectTypes = (restPart(errors, 'assetsObjectTypes', schemaId) {
      restGet(rest, "${insightApi}/objectschema/${schemaId}/objecttypes/flat".toString())
    } ?: []) as List<Map>
    [
      id         : schema.id,
      name       : schema.name,
      key        : schema.objectSchemaKey,
      description: schema.description,
      statuses   : restPart(errors, 'assetsStatuses', schemaId) {
        restGet(rest, "${insightApi}/config/statustype".toString(), [objectSchemaId: schemaId])
      },
      objectTypes: objectTypes.collect { Map objectType ->
        [
          id            : objectType.id,
          name          : objectType.name,
          description   : objectType.description,
          parentId      : objectType.parentObjectTypeId,
          abstractType  : objectType.abstractObjectType,
          inherited     : objectType.inherited,
          objectCount   : objectType.objectCount,
          attributes    : restPart(errors, 'assetsAttributes', "${schemaId}:${objectType.id}".toString()) {
            restGet(rest, "${insightApi}/objecttype/${objectType.id}/attributes".toString())
          },
        ]
      },
    ]
  }
}

/** One REST part: a failure goes to errors and the export continues. */
Object restPart(List<Map> errors, String scope, String key, Closure part) {
  try {
    return part.call()
  } catch (Exception partError) {
    errors << [scope: scope, key: key, message: partError.message]
    return null
  }
}

/** Adds the issue type scheme to the catalogue unless it is already there. */
void rememberIssueTypeScheme(Map<Long, Map> target, List<Map> errors, def issueTypeSchemeManager, FieldConfigScheme issueTypeScheme) {
  Long schemeId = issueTypeScheme?.id as Long
  if (schemeId == null || target.containsKey(schemeId)) {
    return
  }
  try {
    Collection<IssueType> schemeTypes = issueTypeSchemeManager.getIssueTypesForScheme(issueTypeScheme) as Collection<IssueType>
    target.put(schemeId, [
      id         : schemeId,
      name       : issueTypeScheme.name,
      projectKeys: [],
      issueTypes : (schemeTypes ?: [])
        .toList()
        .sort { IssueType type -> type?.name ?: '' }
        .collect { IssueType type ->
          [id: type.id, name: type.name, subTask: type.subTask]
        },
    ])
  } catch (Exception schemeError) {
    errors << [scope: 'issueTypeScheme', key: String.valueOf(schemeId), message: schemeError.message]
  }
}

/** Entity id and name. */
Map ref(Object id, String name) {
  if (id == null && !name) {
    return null
  }
  return [id: id, name: name]
}

/** Screen of an operation. An unset operation falls back to the default item of the scheme. */
Map screenNode(FieldScreenScheme scheme, IssueOperation operation) {
  if (scheme == null || operation == null) {
    return null
  }
  FieldScreen screen = scheme.getFieldScreen(operation)
  if (screen == null) {
    return null
  }
  return [id: screen.id, name: screen.name]
}

/** Keys of the projects using the scheme. */
List<String> sortedKeys(Map<Long, Set<String>> source, Long schemeId) {
  if (schemeId == null) {
    return []
  }
  Set<String> keys = source.get(schemeId)
  if (!keys) {
    return []
  }
  return keys.toList().sort()
}

/** Records a project key for the scheme. */
void addProjectKey(Map<Long, Set<String>> target, Long schemeId, String projectKey) {
  if (schemeId == null || !projectKey) {
    return
  }
  Set<String> keys = target.get(schemeId)
  if (keys == null) {
    keys = new LinkedHashSet<String>()
    target.put(schemeId, keys)
  }
  keys.add(projectKey)
}

/** Screen operation code: default, create, edit, view. */
String operationLabel(IssueOperation operation) {
  if (operation == null) {
    return 'default'
  }
  Long operationId = operation instanceof ScreenableIssueOperation ? operation.id as Long : null
  if (operationId != null && operationId == IssueOperations.CREATE_ISSUE_OPERATION.id) {
    return 'create'
  }
  if (operationId != null && operationId == IssueOperations.EDIT_ISSUE_OPERATION.id) {
    return 'edit'
  }
  if (operationId != null && operationId == IssueOperations.VIEW_ISSUE_OPERATION.id) {
    return 'view'
  }
  return operation.nameKey ?: 'unknown'
}

/** Writes the snapshot into the zip: TSV indexes and one JSON per project, scheme or workflow. */
void writeSnapshotZip(ZipOutputStream zip, Map payload) {
  putJson(zip, 'meta.json', payload.meta ?: [:])
  putJson(zip, 'errors.json', payload.errors ?: [])
  [
    'scriptrunner-report.zip': payload.scriptRunnerReport,
    'automation-rules.json'  : payload.automationRules,
  ].each { String entryName, Object bytes ->
    if (bytes) {
      zip.putNextEntry(new ZipEntry(entryName))
      zip.write(bytes as byte[])
      zip.closeEntry()
    }
  }

  List<List> projectRows = []
  (payload.projects ?: []).each { Map project ->
    String key = project.key ?: 'UNKNOWN'
    putJson(zip, "projects/${key}.json", project)
    Map issueTypeScheme = project.issueTypeScheme as Map
    Map workflowScheme = project.workflowScheme as Map
    Map issueTypeScreenScheme = project.issueTypeScreenScheme as Map
    projectRows << [
      key,
      project.name,
      project.category,
      project.archived,
      project.projectType,
      issueTypeScheme?.id,
      workflowScheme?.id,
      issueTypeScreenScheme?.id,
      (project.permissionScheme as Map)?.id,
      (project.notificationScheme as Map)?.id,
      (project.issueSecurityScheme as Map)?.id,
      (project.lead as Map)?.username,
    ]
  }
  projectRows.sort { List row -> row[0] ?: '' }
  putText(zip, 'index/projects.tsv', tsv([
    'key', 'name', 'category', 'archived', 'projectType',
    'issueTypeSchemeId', 'workflowSchemeId', 'issueTypeScreenSchemeId',
    'permissionSchemeId', 'notificationSchemeId', 'issueSecuritySchemeId', 'lead',
  ], projectRows))
  writeProjectRoles(zip, payload.projects)
  writeGlobals(zip, payload.globals as Map)
  writePermissionSchemes(zip, payload.permissionSchemes)
  writeNotificationSchemes(zip, payload.notificationSchemes)
  writeIssueSecuritySchemes(zip, payload.issueSecuritySchemes)
  writeServiceDesks(zip, payload.serviceDesks)
  writeAssetsSchemas(zip, payload.assetsSchemas)

  writeSchemes(zip, 'issue-type-schemes', 'issue-type-schemes.tsv', ['projectCount', 'issueTypeCount'], payload.issueTypeSchemes) { Map node ->
    return [(node.projectKeys ?: []).size(), (node.issueTypes ?: []).size()]
  }
  writeSchemes(zip, 'workflow-schemes', 'workflow-schemes.tsv', ['defaultWorkflow', 'projectCount', 'mappingCount'], payload.workflowSchemes) { Map node ->
    return [node.defaultWorkflow, (node.projectKeys ?: []).size(), (node.mappings ?: []).size()]
  }
  writeSchemes(zip, 'issue-type-screen-schemes', 'issue-type-screen-schemes.tsv', ['projectCount', 'mappingCount'], payload.issueTypeScreenSchemes) { Map node ->
    return [(node.projectKeys ?: []).size(), (node.mappings ?: []).size()]
  }
  writeSchemes(zip, 'screen-schemes', 'screen-schemes.tsv', ['projectCount', 'screenCount'], payload.screenSchemes) { Map node ->
    return [(node.projectKeys ?: []).size(), (node.screens ?: []).size()]
  }
  writeScreens(zip, payload.screens)
  writeFieldLayouts(zip, payload.fieldLayouts)
  writeFieldLayoutSchemes(zip, payload.fieldLayoutSchemes)
  writeFields(zip, payload.customFields, payload.systemFields)

  Map<String, String> usedSlugs = new LinkedHashMap<String, String>()
  List<List> workflowRows = []
  (payload.workflows ?: []).each { Map workflow ->
    String name = workflow.name ?: 'unnamed'
    String slugName = uniqueSlug(name, usedSlugs)
    Map body = new LinkedHashMap(workflow)
    body.slug = slugName
    putJson(zip, "workflows/${slugName}.json", body)
    workflowRows << [slugName, name, workflow.active, workflow.referencedByScheme]
  }
  workflowRows.sort { List row -> row[1] ?: '' }
  putText(zip, 'index/workflows.tsv', tsv(['slug', 'name', 'active', 'referencedByScheme'], workflowRows))
  writeWorkflowXml(zip, payload.workflowXml)
  writeWorkflowDraftXml(zip, payload.workflowDraftXml)
}

/** XML of all workflows, inactive ones included. */
void writeWorkflowXml(ZipOutputStream zip, List<Map> workflows) {
  List<List> rows = []
  (workflows ?: []).each { Map workflow ->
    if (!workflow?.file) {
      return
    }
    putText(zip, "workflow-xml/${workflow.file}", workflow.xml ?: '')
    rows << [workflow.name, workflow.file, workflow.active]
  }
  rows.sort { List row -> row[0] ?: '' }
  putText(zip, 'index/workflow-xml.tsv', tsv(['workflow', 'file', 'active'], rows))
}

/** XML of the drafts of active workflows: unpublished changes. */
void writeWorkflowDraftXml(ZipOutputStream zip, List<Map> drafts) {
  List<List> rows = []
  (drafts ?: []).each { Map draft ->
    if (!draft?.file) {
      return
    }
    putText(zip, "workflow-xml-drafts/${draft.file}", draft.xml ?: '')
    rows << [draft.name, draft.file]
  }
  rows.sort { List row -> row[0] ?: '' }
  putText(zip, 'index/workflow-xml-drafts.tsv', tsv(['workflow', 'file'], rows))
}

/** Role members of all projects in one table: "who is in role X of project Y". */
void writeProjectRoles(ZipOutputStream zip, List<Map> projects) {
  List<List> rows = []
  (projects ?: []).each { Map project ->
    (project.roles ?: []).each { Map role ->
      (role.actors ?: []).each { Map actor ->
        rows << [project.key, role.id, role.name, actor.type, actor.name ?: actor.key ?: actor.parameter, actor.username, actor.active]
      }
    }
  }
  rows.sort { List row -> "${row[0]} ${row[2]} ${row[3]} ${row[4]}".toString() }
  putText(zip, 'index/project-roles.tsv', tsv(['project', 'roleId', 'role', 'actorType', 'actor', 'username', 'active'], rows))
}

/** Lookups: one JSON per lookup. */
void writeGlobals(ZipOutputStream zip, Map globals) {
  (globals ?: [:]).each { String name, Object values ->
    putJson(zip, "globals/${name}.json", values ?: [])
  }
}

/** Permission schemes: one JSON per scheme and a flat "permission -> holder" table. */
void writePermissionSchemes(ZipOutputStream zip, List<Map> schemes) {
  writeSchemes(zip, 'permission-schemes', 'permission-schemes.tsv', ['projectCount', 'grantCount'], schemes) { Map node ->
    return [(node.projectKeys ?: []).size(), (node.entries ?: []).size()]
  }
  List<List> rows = []
  (schemes ?: []).each { Map scheme ->
    (scheme.entries ?: []).each { Map entry ->
      rows << [scheme.id, scheme.name, entry.permission, entry.type, entry.parameter, entry.name]
    }
  }
  rows.sort { List row -> "${row[1]} ${row[2]} ${row[3]} ${row[4] ?: ''}".toString() }
  putText(zip, 'index/permission-grants.tsv', tsv(['schemeId', 'scheme', 'permission', 'holderType', 'parameter', 'holderName'], rows))
}

/** Notification schemes: one JSON per scheme and a flat "event -> recipient" table. */
void writeNotificationSchemes(ZipOutputStream zip, List<Map> schemes) {
  writeSchemes(zip, 'notification-schemes', 'notification-schemes.tsv', ['projectCount', 'entryCount'], schemes) { Map node ->
    return [(node.projectKeys ?: []).size(), (node.entries ?: []).size()]
  }
  List<List> rows = []
  (schemes ?: []).each { Map scheme ->
    (scheme.entries ?: []).each { Map entry ->
      rows << [scheme.id, scheme.name, entry.eventId, entry.event, entry.type, entry.parameter, entry.name]
    }
  }
  rows.sort { List row -> "${row[1]} ${row[3] ?: ''} ${row[4]}".toString() }
  putText(zip, 'index/notifications.tsv', tsv(['schemeId', 'scheme', 'eventId', 'event', 'recipientType', 'parameter', 'recipientName'], rows))
}

/** Issue security schemes: one JSON per scheme and a "level -> member" table. */
void writeIssueSecuritySchemes(ZipOutputStream zip, List<Map> schemes) {
  writeSchemes(zip, 'issue-security-schemes', 'issue-security-schemes.tsv', ['projectCount', 'levelCount'], schemes) { Map node ->
    return [(node.projectKeys ?: []).size(), (node.levels ?: []).size()]
  }
  List<List> rows = []
  (schemes ?: []).each { Map scheme ->
    (scheme.levels ?: []).each { Map level ->
      (level.members ?: []).each { Map member ->
        rows << [scheme.id, scheme.name, level.id, level.name, member.type, member.parameter, member.name]
      }
    }
  }
  rows.sort { List row -> "${row[1]} ${row[3]} ${row[4]}".toString() }
  putText(zip, 'index/issue-security-levels.tsv', tsv(['schemeId', 'scheme', 'levelId', 'level', 'memberType', 'parameter', 'memberName'], rows))
}

/** JSM: one folder per service desk, one JSON per request type, indexes of request types, form fields and queues. */
void writeServiceDesks(ZipOutputStream zip, List<Map> desks) {
  List<List> typeRows = []
  List<List> fieldRows = []
  List<List> queueRows = []
  (desks ?: []).each { Map desk ->
    String folder = "jsm/${desk.projectKey ?: desk.id}".toString()
    Map deskBody = new LinkedHashMap(desk)
    deskBody.remove('requestTypes')
    putJson(zip, "${folder}/service-desk.json", deskBody)
    Map<String, String> groupNames = (desk.requestTypeGroups ?: []).collectEntries { Map group -> [(group.id as String): group.name] }
    (desk.requestTypes ?: []).each { Map requestType ->
      putJson(zip, "${folder}/request-types/${requestType.id}.json", requestType)
      String groups = (requestType.groupIds ?: []).collect { Object id -> groupNames.get(id as String) ?: id }.join(', ')
      typeRows << [desk.projectKey, desk.id, requestType.id, requestType.name, requestType.issueTypeId, groups]
      [visible: requestType.visible, hidden: requestType.hidden].each { String kind, Object rows ->
        (rows ?: []).each { Map field ->
          String preset = kind == 'hidden' && field.values != null ? JsonOutput.toJson(field.values) : ''
          fieldRows << [desk.projectKey, requestType.id, requestType.name, kind, field.fieldId, field.name, field.label, field.sdRequired, preset]
        }
      }
    }
    (desk.queues ?: []).each { Map queue ->
      queueRows << [desk.projectKey, queue.id, queue.name, queue.jql]
    }
  }
  typeRows.sort { List row -> "${row[0]} ${row[3]}".toString() }
  putText(zip, 'index/jsm-request-types.tsv', tsv(['project', 'serviceDeskId', 'requestTypeId', 'name', 'issueTypeId', 'groups'], typeRows))
  putText(zip, 'index/jsm-request-type-fields.tsv', tsv(
    ['project', 'requestTypeId', 'requestType', 'kind', 'fieldId', 'fieldName', 'label', 'required', 'preset'],
    fieldRows
  ))
  putText(zip, 'index/jsm-queues.tsv', tsv(['project', 'queueId', 'name', 'jql'], queueRows))
}

/** Assets: one JSON per schema with object types and attributes, indexes of object types and attributes. */
void writeAssetsSchemas(ZipOutputStream zip, List<Map> schemas) {
  List<List> typeRows = []
  List<List> attributeRows = []
  (schemas ?: []).each { Map schema ->
    putJson(zip, "assets/${schema.id}.json", schema)
    (schema.objectTypes ?: []).each { Map objectType ->
      typeRows << [schema.id, schema.key, objectType.id, objectType.name, objectType.parentId, objectType.objectCount]
      (objectType.attributes ?: []).each { Map attribute ->
        attributeRows << [
          schema.id,
          objectType.id,
          objectType.name,
          attribute.id,
          attribute.name,
          attribute.defaultType?.name ?: attributeTypeName(attribute.type),
          attribute.referenceObjectTypeId,
          attribute.referenceType?.name,
          attribute.minimumCardinality,
          attribute.maximumCardinality,
        ]
      }
    }
  }
  typeRows.sort { List row -> "${row[1]} ${row[3]}".toString() }
  attributeRows.sort { List row -> "${row[0]} ${row[2]} ${row[4]}".toString() }
  putText(zip, 'index/assets-object-types.tsv', tsv(['schemaId', 'schemaKey', 'objectTypeId', 'name', 'parentId', 'objectCount'], typeRows))
  putText(zip, 'index/assets-attributes.tsv', tsv(
    ['schemaId', 'objectTypeId', 'objectType', 'attributeId', 'name', 'type', 'referenceObjectTypeId', 'referenceType', 'min', 'max'],
    attributeRows
  ))
}

/** Assets attribute type by code when defaultType is missing. */
String attributeTypeName(Object code) {
  Map<Integer, String> names = [0: 'Default', 1: 'Object', 2: 'User', 3: 'Confluence', 4: 'Group', 5: 'Version', 6: 'Project', 7: 'Status']
  return code == null ? null : (names.get(code as Integer) ?: String.valueOf(code))
}

/** Workflow XML in the form the Jira admin UI imports. */
String workflowXml(JiraWorkflow workflow) {
  String raw = WorkflowUtil.convertDescriptorToXML(workflow.descriptor)?.trim() ?: ''
  if (raw.contains('<!DOCTYPE')) {
    return raw.endsWith('\n') ? raw : raw + '\n'
  }
  String body = raw.replaceFirst(/^<\?xml[^>]*\?>\s*/, '')
  String prolog = '''<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE workflow PUBLIC "-//OpenSymphony Group//DTD OSWorkflow 2.8//EN" "http://www.opensymphony.com/osworkflow/workflow_2_8.dtd">
'''
  return prolog + body + (body.endsWith('\n') ? '' : '\n')
}

/**
 * XML file name inside the zip. A repeat after sanitising gets a suffix.
 * Trailing dots and spaces are cut: Windows drops them on extraction and the name would no longer match the index.
 */
String uniqueXmlName(String workflowName, Set<String> usedNames) {
  String source = workflowName ?: 'workflow'
  StringBuilder sanitized = new StringBuilder()
  source.toCharArray().each { char c ->
    boolean unsafe = c < 0x20 || '\\/:*?"<>|'.indexOf((int) c) >= 0
    sanitized.append(unsafe ? '_' : c)
  }
  String base = sanitized.toString().trim()
  if (base.length() > 150) {
    base = base.substring(0, 150)
  }
  base = base.replaceAll(/[. ]+$/, '')
  if (!base) {
    base = 'workflow'
  }
  String candidate = "${base}.xml".toString()
  int index = 2
  while (!usedNames.add(candidate)) {
    candidate = "${base} (${index}).xml".toString()
    index++
  }
  return candidate
}

/** One JSON per screen and the screen and screen-field indexes. */
void writeScreens(ZipOutputStream zip, List<Map> screens) {
  List<List> screenRows = []
  List<List> fieldRows = []
  (screens ?: []).each { Map screen ->
    if (screen?.id == null) {
      return
    }
    int fieldCount = 0
    (screen.tabs ?: []).each { Map tab ->
      (tab.fields ?: []).each { Map field ->
        fieldCount++
        fieldRows << [field.fieldId, field.name, screen.id, screen.name, tab.name, field.position]
      }
    }
    putJson(zip, "screens/${screen.id}.json", screen)
    screenRows << [screen.id, screen.name, (screen.tabs ?: []).size(), fieldCount]
  }
  screenRows.sort { List row -> "${row[1] ?: ''} ${row[0]}".toString() }
  fieldRows.sort { List row -> "${row[1] ?: ''} ${row[3] ?: ''} ${row[5] ?: ''}".toString() }
  putText(zip, 'index/screens.tsv', tsv(['id', 'name', 'tabCount', 'fieldCount'], screenRows))
  putText(zip, 'index/screen-fields.tsv', tsv(['fieldId', 'fieldName', 'screenId', 'screenName', 'tab', 'position'], fieldRows))
}

/** Field configurations: items hold only hidden, required and non-default renderer entries. */
void writeFieldLayouts(ZipOutputStream zip, List<Map> layouts) {
  List<List> layoutRows = []
  List<List> itemRows = []
  (layouts ?: []).each { Map layout ->
    String fileId = layout.id == null ? 'default' : String.valueOf(layout.id)
    putJson(zip, "field-layouts/${fileId}.json", layout)
    layoutRows << [fileId, layout.name, (layout.items ?: []).size()]
    (layout.items ?: []).each { Map item ->
      itemRows << [item.fieldId, item.name, fileId, layout.name, item.hidden, item.required, item.renderer]
    }
  }
  layoutRows.sort { List row -> "${row[1] ?: ''} ${row[0]}".toString() }
  itemRows.sort { List row -> "${row[1] ?: ''} ${row[3] ?: ''}".toString() }
  putText(zip, 'index/field-layouts.tsv', tsv(['id', 'name', 'exceptionCount'], layoutRows))
  putText(zip, 'index/field-layout-items.tsv', tsv(
    ['fieldId', 'fieldName', 'layoutId', 'layoutName', 'hidden', 'required', 'renderer'],
    itemRows
  ))
}

/** Field configuration schemes: issue type to field configuration. */
void writeFieldLayoutSchemes(ZipOutputStream zip, List<Map> schemes) {
  List<List> rows = []
  (schemes ?: []).each { Map scheme ->
    if (scheme?.id == null) {
      return
    }
    putJson(zip, "field-layout-schemes/${scheme.id}.json", scheme)
    rows << [scheme.id, scheme.name, (scheme.projectKeys ?: []).size(), (scheme.mappings ?: []).size()]
  }
  rows.sort { List row -> "${row[1] ?: ''} ${row[0]}".toString() }
  putText(zip, 'index/field-layout-schemes.tsv', tsv(['id', 'name', 'projectCount', 'mappingCount'], rows))
}

/** Fields and contexts. System fields share one file; their context is always global. */
void writeFields(ZipOutputStream zip, List<Map> customFields, List<Map> systemFields) {
  List<List> rows = []
  List<List> optionRows = []
  (customFields ?: []).each { Map field ->
    if (!field?.id) {
      return
    }
    putJson(zip, "fields/${field.id}.json", field)
    boolean global = (field.contexts ?: []).any { Map context -> context.global || context.allProjects }
    rows << [field.id, field.name, 'custom', field.type, global]
    (field.contexts ?: []).each { Map context ->
      (context.options ?: []).each { Map option ->
        optionRows << [field.id, field.name, context.id, option.id, '', option.value, option.disabled]
        (option.children ?: []).each { Map child ->
          optionRows << [field.id, field.name, context.id, child.id, option.id, child.value, child.disabled]
        }
      }
    }
  }
  putText(zip, 'index/field-options.tsv', tsv(['fieldId', 'fieldName', 'contextId', 'optionId', 'parentOptionId', 'value', 'disabled'], optionRows))
  putJson(zip, 'fields/system.json', systemFields ?: [])
  (systemFields ?: []).each { Map field ->
    rows << [field.id, field.name, 'system', '', true]
  }
  rows.sort { List row -> "${row[2] ?: ''} ${row[1] ?: ''}".toString() }
  putText(zip, 'index/fields.tsv', tsv(['id', 'name', 'kind', 'type', 'global'], rows))
}

/** JSON files of one scheme folder and its index row. */
void writeSchemes(ZipOutputStream zip, String folder, String indexName, List<String> extraHeader, List<Map> nodes, Closure extraValues) {
  List<List> rows = []
  (nodes ?: []).each { Map node ->
    if (node?.id == null) {
      return
    }
    String sid = String.valueOf(node.id)
    putJson(zip, "${folder}/${sid}.json", node)
    List row = [sid, node.name]
    row.addAll(extraValues(node) as List)
    rows << row
  }
  rows.sort { List row -> "${row[1] ?: ''} ${row[0]}".toString() }
  List<String> header = ['id', 'name']
  header.addAll(extraHeader)
  putText(zip, "index/${indexName}", tsv(header, rows))
}

/** Writes a JSON entry into the zip. */
void putJson(ZipOutputStream zip, String entryName, Object value) {
  String json = JsonOutput.prettyPrint(JsonOutput.toJson(value))
  if (!json.endsWith('\n')) {
    json = json + '\n'
  }
  putText(zip, entryName, json)
}

/** Writes a text entry into the zip. */
void putText(ZipOutputStream zip, String entryName, String text) {
  zip.putNextEntry(new ZipEntry(entryName))
  zip.write((text ?: '').getBytes(StandardCharsets.UTF_8))
  zip.closeEntry()
}

/** TSV: header and rows. */
String tsv(List header, List<List> rows) {
  List<String> lines = [header.collect { cell(it) }.join('\t')]
  rows.each { List values ->
    lines << values.collect { cell(it) }.join('\t')
  }
  return lines.join('\n') + '\n'
}

/** Text of a TSV cell. */
String cell(Object value) {
  if (value == null) {
    return ''
  }
  return value.toString().replace('\t', ' ').replace('\r', ' ').replace('\n', ' ')
}

/** Workflow file name without characters that paths forbid. */
String uniqueSlug(String name, Map<String, String> usedSlugs) {
  String base = slug(name)
  String slugName = base
  int index = 2
  while (usedSlugs.containsKey(slugName) && usedSlugs.get(slugName) != name) {
    slugName = base.length() > 70 ? base.substring(0, 70) + '_' + index : base + '_' + index
    index++
  }
  usedSlugs.put(slugName, name)
  return slugName
}

/** Safe file name fragment. */
String slug(String name) {
  String text = (name ?: '').replaceAll('[\\\\/:*?"<>|\\s]+', '_')
  text = text.replaceAll('^[._]+', '').replaceAll('[._]+$', '')
  if (!text) {
    return 'unnamed'
  }
  return text.length() > 80 ? text.substring(0, 80) : text
}
