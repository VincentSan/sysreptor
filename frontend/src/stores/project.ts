import { orderBy, pick, set } from "lodash-es";
import { groupNotes } from "@/stores/usernotes";
import type { PentestFinding, PentestProject, ProjectNote, ReportSection } from "~/utils/types";
import { scoreFromVector } from "~/utils/cvss";

export function sortFindings<T extends PentestFinding>({ findings, projectType, overrideFindingOrder = false, topLevelFields = false }: {findings: T[], projectType: ProjectType, overrideFindingOrder?: boolean, topLevelFields?: boolean}): T[] {
  if (overrideFindingOrder || projectType.finding_ordering.length === 0) {
    return orderBy(findings, ['order', 'created']);
  } else {
    return orderBy(
      findings,
      projectType.finding_ordering.map(o => (finding: T) => {
        const v = topLevelFields ? (finding as any)[o.field] : finding.data[o.field];
        const d = projectType.finding_fields[o.field];
        if (!d || d.type in [FieldDataType.LIST, FieldDataType.OBJECT, FieldDataType.USER] || Array.isArray(v) || typeof v === 'object') {
          // Sorting by field is unsupported
          return '';
        } else if (d.type === FieldDataType.CVSS) {
          return scoreFromVector(v) || 0;
        } else if (d.type === FieldDataType.CWE) {
          if (!v) {
            return -1;
          } 
          return Number(v.replace('CWE-'))
        } else if (d.type === FieldDataType.ENUM) {
          return d.choices!.findIndex(c => c.value === v);
        } else if (v !== null && v !== undefined) {
          return v;
        } else if (d.type === FieldDataType.NUMBER) {
          return 0;
        } else if (d.type === FieldDataType.BOOLEAN) {
          return false;
        } else {
          return '';
        }
      }).concat(f => f.created),
      projectType.finding_ordering.map(o => o.order).concat([SortOrder.ASC])
    );
  }
}

export const useProjectStore = defineStore('project', {
  state: () => ({
    data: {} as Record<string, {
      project: PentestProject|null,
      getByIdSync: Promise<PentestProject> | null,
      notesCollabState: CollabStoreState<{ notes: Record<string, ProjectNote>}>,
      reportingCollabState: CollabStoreState<{ 
        project: {id: string, project_type: string, override_finding_order: boolean}, 
        findings: Record<string, PentestFinding>, 
        sections: Record<string, ReportSection>, 
      }>,
    }>,
  }),
  getters: {
    project() {
      return (projectId: string) => this.data[projectId]?.project;
    },
    findings() {
      return (projectId: string, { projectType = null as ProjectType|null } = {}) => {
        const projectState = this.data[projectId]
        let findings = Object.values(this.data[projectId]?.reportingCollabState.data.findings || {});
        // Sort findings
        if (projectState && projectType) {
          findings = sortFindings({
            findings,
            projectType,
            overrideFindingOrder: projectState.project!.override_finding_order,
          })
        }
        return findings;
      };
    },
    sections() {
      return (projectId: string, { projectType = null as ProjectType|null } = {}) => {
        let sections = Object.values(this.data[projectId]?.reportingCollabState.data.sections || {});
        // Sort sections
        if (projectType) {
          sections = orderBy(sections, [s => projectType.report_sections.findIndex(rs => rs.id === s.id)]);
        }
        return sections;
      };
    },
    notes() {
      return (projectId: string) => Object.values(this.data[projectId]?.notesCollabState.data.notes || {});
    },
    noteGroups() {
      return (projectId: string) => groupNotes(this.notes(projectId));
    },
  },
  actions: {
    clear() {
      this.data = {};
    },
    ensureExists(projectId: string, initialStoreData?: Object) {
      if (!(projectId in this.data)) {
        this.data[projectId] = {
          project: null as unknown as PentestProject,
          getByIdSync: null,
          notesCollabState: makeCollabStoreState({
            apiPath: `/ws/pentestprojects/${projectId}/notes/`,
            initialData: { notes: {} as Record<string, ProjectNote>},
            initialPath: 'notes',
            handleAdditionalWebSocketMessages: (msgData: any, collabState) => {
              if (msgData.type === CollabEventType.SORT && msgData.path === 'notes') {
                for (const note of Object.values(collabState.data.notes)) {
                  const no = msgData.sort.find((n: ProjectNote) => n.id === note.id);
                  note.parent = no?.parent || null;
                  note.order = no?.order || 0;
                }
                return true;
              } else {
                return false;
              }
            }
          }),
          reportingCollabState: makeCollabStoreState({
            apiPath: `/ws/pentestprojects/${projectId}/reporting/`,
            initialData: { project: {} as any, findings: {} as Record<string, PentestFinding>, sections: {} as Record<string, ReportSection> },
            handleAdditionalWebSocketMessages: (msgData: any, collabState) => {
              if (msgData.type === CollabEventType.SORT && msgData.path === 'findings') {
                for (const finding of Object.values(collabState.data.findings)) {
                  const fo = msgData.sort.find((n: PentestFinding) => n.id === finding.id);
                  finding.order = fo?.order || 0;
                }
                return true;
              } else if (msgData.type === CollabEventType.UPDATE_KEY && msgData.path?.startsWith('project.')) {
                set(this.data[projectId].project || {} as Object, msgData.path.slice('project.'.length), msgData.value);
                if (msgData.path === 'project.project_type') {
                  // Reload page on project_type changed to apply the new field definition
                  this.useReportingCollab({ project: this.data[projectId].project! }).disconnect();
                  reloadNuxtApp({ force: true });
                }

                // Let the default handler update the key in store state
                return false;
              } else {
                return false;
              }
            }
          }),
          ...(initialStoreData || {})
        }
      }
      return this.data[projectId];
    },
    setProject(project: PentestProject) {
      this.ensureExists(project.id);
      this.data[project.id].project = project;
      return this.data[project.id].project!;
    },
    async fetchById(projectId: string): Promise<PentestProject> {
      const obj = await $fetch<PentestProject>(`/api/v1/pentestprojects/${projectId}/`, { method: 'GET' });
      return this.setProject(obj);
    },
    async getById(projectId: string): Promise<PentestProject> {
      if (Array.isArray(projectId)) {
        projectId = projectId[0];
      }

      if (projectId in this.data && this.data[projectId].project) {
        return this.data[projectId].project!;
      } else if (projectId in this.data && this.data[projectId].getByIdSync) {
        return await this.data[projectId].getByIdSync!;
      } else {
        try {
          const getByIdSync = this.fetchById(projectId);
          this.ensureExists(projectId, { getByIdSync });
          return await getByIdSync;
        } finally {
          if (this.data[projectId]?.getByIdSync) {
            this.data[projectId].getByIdSync = null;
          }
        }
      }
    },
    async createProject(projectData: Object) {
      const proj = await $fetch<PentestProject>(`/api/v1/pentestprojects/`, {
        method: 'POST',
        body: projectData
      });
      return this.setProject(proj);
    },
    async partialUpdateProject(project: PentestProject, fields?: string[]) {
      const proj = await $fetch<PentestProject>(`/api/v1/pentestprojects/${project.id}/`, {
        method: 'PATCH',
        body: fields ? pick(project, fields?.concat(['id'])) : project,
      });
      return this.setProject(proj);
    },
    async deleteProject(project: PentestProject) {
      await $fetch(`/api/v1/pentestprojects/${project.id}/`, {
        method: 'DELETE'
      });
      if (project.id in this.data) {
        delete this.data[project.id];
      }
    },
    async copyProject(project: PentestProject) {
      const proj = await $fetch<PentestProject>(`/api/v1/pentestprojects/${project.id}/copy/`, {
        method: 'POST',
        body: {}
      });
      return this.setProject(proj);
    },
    async setReadonly(project: PentestProject, readonly: boolean) {
      await $fetch(`/api/v1/pentestprojects/${project.id}/readonly/`, {
        method: 'PATCH',
        body: {
          readonly,
        }
      });
      this.ensureExists(project.id);
      this.data[project.id].project!.readonly = readonly;
    },
    async customizeDesign(project: PentestProject) {
      const res = await $fetch<{ project_type: string }>(`/api/v1/pentestprojects/${project.id}/customize-projecttype/`, {
        method: 'POST',
        body: {}
      });
      this.ensureExists(project.id);
      this.setProject({ ...this.data[project.id].project!, project_type: res.project_type });
    },
    async createFinding(project: PentestProject, findingData: Object) {
      const finding = await $fetch<PentestFinding>(`/api/v1/pentestprojects/${project.id}/findings/`, {
        method: 'POST',
        body: findingData,
      });
      this.ensureExists(project.id)
      this.data[project.id].reportingCollabState.data.findings[finding.id] = finding;
      return finding;
    },
    async createFindingFromTemplate(project: PentestProject, findingFromTemplateData: { template: string, template_language: string }) {
      const finding = await $fetch<PentestFinding>(`/api/v1/pentestprojects/${project.id}/findings/fromtemplate/`, {
        method: 'POST',
        body: findingFromTemplateData,
      });
      this.ensureExists(project.id)
      this.data[project.id].reportingCollabState.data.findings[finding.id] = finding;
      return finding;
    },
    async deleteFinding(project: PentestProject, finding: PentestFinding) {
      await $fetch(`/api/v1/pentestprojects/${project.id}/findings/${finding.id}/`, {
        method: 'DELETE'
      });
      if (project.id in this.data) {
        delete this.data[project.id].reportingCollabState.data.findings[finding.id];
      }
    },
    async sortFindings(project: PentestProject, findings: PentestFinding[]) {
      this.ensureExists(project.id);
      const orderedFindings = findings.map((f, idx) => ({ ...(this.findings(project.id).find(fs => fs.id === f.id) || f), order: idx + 1 }));
      this.data[project.id].reportingCollabState.data.findings = Object.fromEntries(orderedFindings.map(f => [f.id, f]));
      await $fetch<{ id: string; order: number }[]>(`/api/v1/pentestprojects/${project.id}/findings/sort/`, {
        method: 'POST',
        body: orderedFindings.map(f => ({ id: f.id, order: f.order })),
      });
    },
    async createNote(project: PentestProject, note: ProjectNote) {
      note = await $fetch<ProjectNote>(`/api/v1/pentestprojects/${project.id}/notes/`, {
        method: 'POST',
        body: note
      });
      this.ensureExists(project.id);
      this.data[project.id].notesCollabState.data.notes[note.id] = note;
      return note;
    },
    async deleteNote(project: PentestProject, note: ProjectNote) {
      await $fetch(`/api/v1/pentestprojects/${project.id}/notes/${note.id}/`, {
        method: 'DELETE'
      });
      if (project.id in this.data) {
        delete this.data[project.id].notesCollabState.data.notes[note.id];
      }
    },
    async sortNotes(project: PentestProject, noteGroups: NoteGroup<ProjectNote>) {
      this.ensureExists(project.id)
      const notes = [] as ProjectNote[];
      sortNotes(noteGroups, (n) => {
        notes.push(n);
      });
      this.data[project.id].notesCollabState.data.notes = Object.fromEntries(notes.map(n => [n.id, n]));
      await $fetch<{id: string; parent: string|null; order: number}[]>(`/api/v1/pentestprojects/${project.id}/notes/sort/`, {
        method: 'POST',
        body: notes.map(n => pick(n, ['id', 'parent', 'order']))
      });
    },
    useNotesCollab(options: { project: PentestProject, noteId?: string }) {
      this.ensureExists(options.project.id);

      const collabState = this.data[options.project.id].notesCollabState;
      const collab = useCollab(collabState);
      const collabProps = computed(() => collabSubpath(collab.collabProps.value, options.noteId ? `notes.${options.noteId}` : null))

      const apiSettings = useApiSettings();
      const auth = useAuth();
      const hasLock = ref(true);
      if (options.noteId && !apiSettings.isProfessionalLicense) {
        hasLock.value = false;
        watch(() => collabProps.value.clients, () => {
          if (!hasLock.value && collabProps.value.clients.filter(c => c.user.id !== auth.user.value?.id).length === 0) {
            hasLock.value = true;
          }
        }, { immediate: true });
      }

      async function connect() {
        if (options.project.readonly) {
          return await collab.connect({ connectionType: CollabConnectionType.HTTP_READONLY });
        }
        return await collab.connect();
      }

      return {
        ...collab,
        collabProps,
        hasLock,
        readonly: computed(() => collab.readonly.value || !hasLock.value),
        connect,
      };
    },
    useReportingCollab(options: { project: PentestProject, findingId?: string, sectionId?: string }) {
      this.ensureExists(options.project.id);

      const collabState = this.data[options.project.id].reportingCollabState;
      const collab = useCollab(collabState);
      const collabProps = computed(() => collabSubpath(collab.collabProps.value, options.findingId ? `findings.${options.findingId}` : options.sectionId ? `sections.${options.sectionId}` : null));

      const apiSettings = useApiSettings();
      const auth = useAuth();
      const hasLock = ref(true);
      if ((options.findingId || options.sectionId) && !apiSettings.isProfessionalLicense) {
        hasLock.value = false;
        watch(() => collabProps.value.clients, () => {
          if (!hasLock.value && collabProps.value.clients.filter(c => c.user.id !== auth.user.value?.id).length === 0) {
            hasLock.value = true;
          }
        }, { immediate: true });
      }

      async function connect() {
        if (options.project.readonly) {
          return await collab.connect({ connectionType: CollabConnectionType.HTTP_READONLY });
        }
        return await collab.connect();
      }

      return {
        ...collab,
        collabProps,
        hasLock,
        readonly: computed(() => collab.readonly.value || !hasLock.value),
        connect,
      };
    },
  },
})
