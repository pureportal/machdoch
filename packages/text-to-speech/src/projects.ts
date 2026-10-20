import {useCallback,useEffect,useRef,useState} from "react";
import type {SpeechProject,SpeechProjectSummary,SpeechRuntime} from "@machdoch/speech";
import {errorText} from "./controls.tsx";
import {speechDrafts, type SpeechDraft} from "./drafts.ts";
const PROJECT_PAGE_SIZE=20;
function projectSummary(project:SpeechProject):SpeechProjectSummary{const {id,title,revisionId,updatedAt,archived,location,profileId}=project;return {id,title,revisionId,updatedAt,archived,location,profileId};}
export function useProjects(runtime: SpeechRuntime, report: (error: unknown) => void) {
  const [project, setProject] = useState<SpeechProject | null>(null);
  const [projects, setProjects] = useState<SpeechProjectSummary[]>([]);
  const [projectPage,setProjectPage]=useState({offset:0,total:0,limit:PROJECT_PAGE_SIZE});
  const listing=useRef({search:"",archived:false,offset:0});
  const listVersion=useRef(0);
  const [conflict, setConflict] = useState<SpeechProject | null>(null);
  const [saveState, setSaveState] = useState("Saved");
  const current = useRef<SpeechProject | null>(null);
  const saved = useRef<SpeechProject | null>(null);
  const conflicting = useRef<SpeechProject | null>(null);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const draftQueue = useRef<Promise<unknown>>(Promise.resolve());
  const pendingDraft = useRef<SpeechDraft | null>(null);
  const writingDraft = useRef(false);
  const editorId = useRef(crypto.randomUUID());
  const [recovery, setRecovery] = useState<SpeechDraft[]>([]);
  useEffect(()=>{return()=>{listVersion.current++;};},[runtime]);
  const loadProjects=useCallback(async(filters:Partial<typeof listing.current>={}):Promise<void>=>{
    const query={...listing.current,...filters,limit:PROJECT_PAGE_SIZE};const version=++listVersion.current;
    const page=await runtime.execute("listProjects",query);
    if(version!==listVersion.current)return;
    if(page.offset!==query.offset||page.limit!==PROJECT_PAGE_SIZE||!Number.isSafeInteger(page.total)||page.total<0||page.projects.length>PROJECT_PAGE_SIZE)throw new Error("The speech project page is invalid. Reload the project list.");
    listing.current={search:query.search,archived:query.archived,offset:page.offset};setProjects(page.projects);setProjectPage({offset:page.offset,total:page.total,limit:page.limit});
  },[runtime]);
  const persistDraft = useCallback((task: () => Promise<void>) => {
    const pending = draftQueue.current.catch(() => undefined).then(task);
    draftQueue.current = pending;
    void pending.catch(report);
    return pending;
  }, [report]);

  const install = useCallback((value: SpeechProject | null) => {
    current.current = value;
    saved.current = value;
    conflicting.current = null;
    setProject(value);
    setConflict(null);
    setSaveState("Saved");
    setRecovery([]);
  }, []);

  const edit = useCallback((change: (value: SpeechProject) => SpeechProject) => {
    if (!current.current) return;
    const next = change(current.current);
    current.current = next;
    setProject(next);
    setSaveState(conflicting.current ? "Conflict" : "Unsaved");
    const base = saved.current;
    if (base) {
      const draft: SpeechDraft = {id: `${base.id}:${editorId.current}`, editorId: editorId.current, projectId: base.id, baseRevisionId: base.revisionId, savedAt: new Date().toISOString(), project: next};
      pendingDraft.current = draft;
      if (!writingDraft.current) {
        writingDraft.current = true;
        void persistDraft(async () => {
          try {
            while (pendingDraft.current) {
              const next = pendingDraft.current;
              pendingDraft.current = null;
              await speechDrafts.save(next);
            }
          } finally { writingDraft.current = false; }
        });
      }
    }
  }, [persistDraft]);

  const save = useCallback((): Promise<SpeechProject | null> => {
    const task = queue.current.then(async () => {
      while (current.current && current.current !== saved.current) {
        if (conflicting.current) throw new Error("Resolve the project conflict before saving.");
        const draft = current.current;
        const base = saved.current;
        setSaveState("Saving");
        let result: SpeechProject;
        try {
          result = await runtime.execute("saveProject", { project: draft, expectedRevisionId: base?.revisionId ?? null });
        } catch (error) {
          if (base) {
            let remote: SpeechProject;
            try {
              remote = await runtime.execute("getProject", { id: base.id });
            } catch (checkError) {
              setSaveState("Unsaved");
              throw new Error(errorText(error) + " Latest revision could not be checked: " + errorText(checkError));
            }
            if (remote.revisionId !== base.revisionId) {
              conflicting.current = remote;
              setConflict(remote);
              setSaveState("Conflict");
              throw new Error("This project changed elsewhere. Reload it or save your edits as a copy.");
            }
          }
          setSaveState("Unsaved");
          throw error;
        }
        saved.current = result;
        const latest = current.current;
        if (!latest || latest.id !== draft.id) throw new Error("The active project changed during saving.");
        current.current = latest === draft ? result : {
          ...latest, revisionId: result.revisionId, parentRevisionId: result.parentRevisionId, updatedAt: result.updatedAt,
        };
        setProject(current.current);
        setProjects(items => items.map(item=>item.id===result.id?projectSummary(result):item));
        if (latest === draft) {
          await persistDraft(() => speechDrafts.remove(`${draft.id}:${editorId.current}`));
        }
      }
      setSaveState("Saved");
      return current.current;
    });
    queue.current = task.then(() => undefined, error => { report(error); });
    return task;
  }, [runtime, report, persistDraft]);

  useEffect(() => {
    if (!project || project === saved.current || conflict) return;
    const timer = window.setTimeout(() => { void save().catch(report); }, 650);
    return () => window.clearTimeout(timer);
  }, [project, conflict, save, report]);

  useEffect(() => {
    const preventLoss = (event: BeforeUnloadEvent) => {
      if (current.current !== saved.current) { event.preventDefault(); event.returnValue = ""; }
    };
    window.addEventListener("beforeunload", preventLoss);
    return () => window.removeEventListener("beforeunload", preventLoss);
  }, []);

  useEffect(() => () => {
    if (!conflicting.current) void save().catch(report);
  }, [save, report]);

  const create = async (title: string) => {
    await save();
    const now = new Date().toISOString();
    const draft: SpeechProject = {
      id: crypto.randomUUID(), title: title.trim(), source: "", cast: [], profileId: null,
      revisionId: crypto.randomUUID(), parentRevisionId: null, createdAt: now, updatedAt: now,
      archived: false, location: null, timeline: [], selectedTakes: {}, bookmarks: [], variants: [],
    };
    const result = await runtime.execute("saveProject", { project: draft, expectedRevisionId: null });
    install(result);
    await loadProjects({search:"",archived:false,offset:0});
  };

  const open = useCallback(async (value: SpeechProject) => {
    const drafts = await speechDrafts.list(value.id);
    install(value);
    setRecovery(drafts.filter(draft => JSON.stringify(draft.project) !== JSON.stringify(value)));
  }, [install]);

  const recover = async (draft: SpeechDraft) => {
    const remote = saved.current;
    if (!remote || remote.id !== draft.projectId) throw new Error("Reopen this draft's project before restoring it.");
    edit(() => ({...draft.project, revisionId: remote.revisionId, parentRevisionId: remote.parentRevisionId, createdAt: remote.createdAt, updatedAt: remote.updatedAt}));
    if (draft.baseRevisionId !== remote.revisionId) {
      conflicting.current = remote;
      setConflict(remote);
      setSaveState("Conflict");
    }
    await draftQueue.current;
    await speechDrafts.remove(draft.id);
    setRecovery(items => items.filter(item => item.id !== draft.id));
  };

  const discardRecovery = async (id: string) => {
    await speechDrafts.remove(id);
    setRecovery(items => items.filter(item => item.id !== id));
  };

  const accept = async (value: SpeechProject | null) => {
    const previous = current.current;
    if (previous) await persistDraft(() => speechDrafts.remove(`${previous.id}:${editorId.current}`));
    install(value);
  };

  const duplicate = async (title: string) => {
    const source=await save();
    if (!source) throw new Error("Open a project before duplicating it.");
    const copy=await runtime.execute("duplicateProject",{id:source.id,expectedRevisionId:source.revisionId,title});
    install(copy);
    await loadProjects({search:"",archived:false,offset:0});
    return copy;
  };

  return { project, projects, projectPage, loadProjects, conflict, saveState, install, edit, save, create, duplicate, current, open, recovery, recover, discardRecovery, accept };
}
