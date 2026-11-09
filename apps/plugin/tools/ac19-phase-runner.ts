// biome-ignore-all lint/style/noRestrictedImports: Reuse guarded desktop acceptance helpers.
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
	assertAuthorizedVault,
	createAc19FixturePaths,
	type DesktopVaultId,
} from "./desktop-acceptance";

/** Resolves only the authorized dev-2 path before any host command can run. */
function authorizeTarget(
	id: string,
	resolvedPath: string,
	home = homedir(),
): string {
	if (id !== "dev-2") throw new Error("Unauthorized vault target");
	return assertAuthorizedVault(id, resolvedPath, home);
}

/** Returns the one canonical source and its excluded placeholder path. */
function fixedFixturePaths(): { source: string; placeholder: string } {
	const { source, placeholder } = createAc19FixturePaths(
		"dev-2",
		[],
		"simulated-eviction-p6-20261106-01",
	);
	return { source, placeholder };
}

/** Closed order for the one authorized bounded service case. */
export const AC19_PHASES = [
	"preflight",
	"enable-coexistence",
	"resume",
	"service-absence",
	"seed",
	"service-baseline",
	"evict",
	"capture",
	"service-captured",
	"restore",
	"service-restored",
	"disable-coexistence",
	"cleanup-delete",
	"pause",
	"service-final",
	"status",
] as const;

/** One fixed safe checkpoint. It never contains paths, payloads, or service bodies. */
export interface Ac19PhaseCheckpoint {
	phase: (typeof AC19_PHASES)[number];
	status: "ready" | "pending" | "passed" | "failed" | "paused" | "uncertain";
	at?: number;
	clientId?: string;
	counts?: {
		operations: number;
		applies: number;
		attention: number;
		confirmations: number;
	};
	attentionHash?: string;
	flags?: {
		paused?: boolean;
		coexistence?: boolean;
		placeholderExcluded?: boolean;
		historyUnchanged?: boolean;
		serviceUnchanged?: boolean;
		tombstoneObserved?: boolean;
		placeholderAbsent?: boolean;
	};
	retryAfterMs?: number;
}

/** CLI result shape used by the injected test adapter and synchronous process adapter. */
export interface Ac19CliResult {
	status: number | null;
	stdout: string;
	/** True when spawnSync reports an operating-system process error. */
	spawnError?: boolean;
	/** Set when the process ends from a signal rather than an exit code. */
	signal?: string | null;
}

/** Builds the host-side phase code shared by each short, independently guarded evaluation. */
function createPhaseAction(phase: (typeof AC19_PHASES)[number]): string {
	switch (phase) {
		case "enable-coexistence":
			return `return start(async()=>{assertActive();if(plugin.syncPaused!==true||plugin.composition!==null)throw Error("AC19P6_MODE_STATE");const update=Reflect.get(plugin,"changeCoexistenceMode"),generation=Reflect.get(plugin,"lifecycleGeneration");if(typeof update!=="function"||typeof generation!=="number")throw Error("AC19P6_MODE_CONTROL_UNAVAILABLE");await update.call(plugin,generation,true);assertActive();if(!plugin.settingsValue.coexistenceMode)throw Error("AC19P6_MODE_PENDING");return safe("passed",{paused:true,coexistence:true});});`;
		case "resume":
			return `return start(async()=>{assertActive();if(plugin.syncPaused!==true||plugin.composition!==null)throw Error("AC19P6_RESUME_STATE");plugin.settingsTab.syncActions.resume();if(!await waitFor(()=>!plugin.syncPaused&&plugin.composition!==null))throw Error("AC19P6_RESUME_TIMEOUT");assertActive();s.private.manifestReader=Reflect.get(plugin.composition.reconciliation,"remote");if(!s.private.manifestReader?.manifest)throw Error("AC19P6_MANIFEST_UNAVAILABLE");return safe("passed",{paused:false,coexistence:Boolean(plugin.settingsValue.coexistenceMode)});});`;
		case "service-absence":
			return `return start(async()=>{const m=await readManifest();if(m.epoch!==s.private.epoch||m.rows.some((x)=>x.path===source||x.path===placeholder))throw Error("AC19P6_SERVICE_PRESENT");s.private.manifest=m;return safe("passed",{serviceUnchanged:true,placeholderAbsent:true});});`;
		case "seed":
			return `return start(async()=>{assertActive();if(sourceExists()||v.getAbstractFileByPath(placeholder))throw Error("AC19P6_COLLISION");if(!plugin.settingsValue.coexistenceMode||plugin.syncPaused)throw Error("AC19P6_SEED_STATE");const text="OAB-10.1 synthetic coexistence fixture\\n";s.private.fixtureBytes=Array.from(new TextEncoder().encode(text));if(!await adapter.stat("oab-10.1")){assertActive();await adapter.mkdir("oab-10.1");assertActive();}if(!await adapter.stat("oab-10.1/dev-2")){assertActive();await adapter.mkdir("oab-10.1/dev-2");assertActive();}await v.create(source,text);assertActive();await plugin.desktopSync.syncNow();assertActive();return safe("passed",{coexistence:true});});`;
		case "service-baseline":
			return `return start(async()=>{assertActive();const j=current(),m=await readManifest(),base=j.base?.[source],row=m.rows.find((x)=>x.path===source),reader=s.private.manifestReader,readCurrent=Reflect.get(reader,"readCurrent");if(!base||base.deleted||!row||row.deleted||typeof row.etag!=="string"||row.hash!==base.hash||m.epoch!==j.epoch||m.rows.some((x)=>x.path===placeholder)||typeof reader?.readCurrentAuthority!=="function"||typeof readCurrent!=="function")throw Error("AC19P6_BASELINE_MISMATCH");assertActive();const currentAuthority=await readCurrent.call(reader,source);assertActive();const authority=await reader.readCurrentAuthority(source);assertActive();if(currentAuthority.deleted||currentAuthority.epoch!==m.epoch||currentAuthority.etag!==row.etag||authority.deleted||authority.epoch!==j.epoch||authority.epoch!==m.epoch||authority.rev!==base.rev||authority.hash!==base.hash)throw Error("AC19P6_BASELINE_MISMATCH");s.private.authority={epoch:authority.epoch,rev:authority.rev,hash:authority.hash,etag:row.etag};return safe("passed",{serviceUnchanged:false});});`;
		case "evict":
			return `return start(async()=>{assertActive();if(!sourceExists()||v.getAbstractFileByPath(placeholder))throw Error("AC19P6_EVICTION_STATE");const file=v.getAbstractFileByPath(source);await v.trash(file,false);assertActive();await v.createBinary(placeholder,new ArrayBuffer(0));return safe("passed",{placeholderExcluded:true});});`;
		case "capture":
			return `return start(async()=>{assertActive();if(!await waitFor(()=>{const j=current();return j.coexistence_confirmations.some((x)=>x.path===source)&&j.unavailable_paths.includes(source);}))throw Error("AC19P6_CONFIRMATION_TIMEOUT");assertActive();const j=current(),durable=await Reflect.get(journal,"storage").readState();assertActive();const found=j.coexistence_confirmations.find((x)=>x.path===source),durableConfirmations=durable?.coexistence_confirmations,durableFound=durableConfirmations?.find((x)=>x.path===source);if(!found||!durableFound||found.id!==durableFound.id||!same(durableConfirmations,j.coexistence_confirmations))throw Error("AC19P6_CONFIRMATION_MISSING");if(j.coexistence_confirmations.length!==s.private.confirmations.length+1||!captureHistory(j))throw Error("AC19P6_HISTORY_CHANGED");const placeholderExcluded=!Object.hasOwn(j.base,placeholder)&&!j.pending_ops.some((x)=>x.path===placeholder||x.to===placeholder)&&!j.pending_apply.some((x)=>x.path===placeholder);if(!placeholderExcluded)throw Error("AC19P6_PLACEHOLDER_INCLUDED");s.private.confirmationId=found.id;s.private.confirmationState=durable;return safe("passed",{placeholderExcluded:true,historyUnchanged:true});});`;
		case "service-captured":
			return `return start(async()=>{const m=await readManifest(),row=m.rows.find((x)=>x.path===source),j=current(),base=j.base?.[source];if(!row||row.deleted||row.etag!==s.private.authority.etag||row.hash!==s.private.authority.hash||m.epoch!==s.private.authority.epoch||m.rows.some((x)=>x.path===placeholder)||!base||base.deleted||base.rev!==s.private.authority.rev||base.hash!==s.private.authority.hash||j.epoch!==s.private.authority.epoch)throw Error("AC19P6_SERVICE_CHANGED");const ops=j.pending_ops.filter((x)=>(x.op==="delete"||x.op==="rename")&&(x.path===source||x.to===source));if(ops.length||!captureHistory(j))throw Error("AC19P6_EVICTION_PUBLISHED");return safe("passed",{serviceUnchanged:true,historyUnchanged:true,placeholderAbsent:true});});`;
		case "restore":
			return `return start(async()=>{assertActive();const c=current().coexistence_confirmations.find((x)=>x.id===s.private.confirmationId&&x.path===source),bytes=s.private.fixtureBytes;if(!c||plugin.syncPaused||!Array.isArray(bytes)||!bytes.every((x)=>Number.isInteger(x)&&x>=0&&x<=255))throw Error("AC19P6_RESTORE_STATE");const placeholderFile=v.getAbstractFileByPath(placeholder);if(placeholderFile)await v.trash(placeholderFile,false);assertActive();if(v.getAbstractFileByPath(placeholder))throw Error("AC19P6_PLACEHOLDER_REMAINS");if(!await waitFor(()=>!current().unavailable_paths.includes(source)))throw Error("AC19P6_PLACEHOLDER_BLOCKED");assertActive();const text=new TextDecoder().decode(new Uint8Array(bytes)),restored=await v.create(source,text);assertActive();const actual=await v.read(restored);if(JSON.stringify(Array.from(new TextEncoder().encode(actual)))!==JSON.stringify(bytes))throw Error("AC19P6_RESTORE_BYTES_MISMATCH");await plugin.coexistence.keepServerState(c.id);assertActive();if(current().coexistence_confirmations.some((x)=>x.id===c.id)||!sourceExists())throw Error("AC19P6_CONFIRMATION_REMAINS");await plugin.desktopSync.syncNow();assertActive();return safe("passed",{placeholderExcluded:true,coexistence:true});});`;
		case "service-restored":
			return `return start(async()=>{const j=current(),durable=await Reflect.get(journal,"storage").readState(),m=await readManifest(),base=j.base?.[source];if(!sourceExists()||j.coexistence_confirmations.some((x)=>x.path===source)||durable?.coexistence_confirmations?.some((x)=>x.path===source)||!same(durable?.coexistence_confirmations,j.coexistence_confirmations)||!captureHistory(j)||m.epoch!==s.private.authority.epoch||!base||base.deleted||base.rev!==s.private.authority.rev||base.hash!==s.private.authority.hash||!m.rows.some((x)=>x.path===source&&!x.deleted&&x.etag===s.private.authority.etag&&x.hash===s.private.authority.hash))throw Error("AC19P6_RESTORE_MISMATCH");return safe("passed",{historyUnchanged:true,serviceUnchanged:true});});`;
		case "disable-coexistence":
			return `return start(async()=>{assertActive();if(current().coexistence_confirmations.some((x)=>x.path===source)||plugin.desktopSync.isBusy)throw Error("AC19P6_CONFIRMATION_PENDING");const update=Reflect.get(plugin,"changeCoexistenceMode"),generation=Reflect.get(plugin,"lifecycleGeneration");if(typeof update!=="function"||typeof generation!=="number")throw Error("AC19P6_MODE_CONTROL_UNAVAILABLE");await update.call(plugin,generation,false);assertActive();if(plugin.settingsValue.coexistenceMode)throw Error("AC19P6_MODE_PENDING");return safe("passed",{coexistence:false});});`;
		case "cleanup-delete":
			return `return start(async()=>{assertActive();if(!sourceExists()||v.getAbstractFileByPath(placeholder)||plugin.syncPaused||plugin.settingsValue.coexistenceMode)throw Error("AC19P6_DELETE_STATE");const file=v.getAbstractFileByPath(source);await v.trash(file,false);assertActive();await plugin.desktopSync.syncNow();assertActive();const j=current(),tombstone=j.base?.[source];if(!tombstone?.deleted||!Number.isSafeInteger(tombstone.rev)||tombstone.rev<=s.private.authority.rev||j.pending_ops.some((x)=>x.path===source||x.to===source)||!captureHistory(j))throw Error("AC19P6_DELETE_RECEIPT");s.private.deleteReceipt={epoch:j.epoch,rev:tombstone.rev};return safe("passed");});`;
		case "service-final":
			return `return start(async()=>{const m=await readManifest(),j=current(),row=m.rows.find((x)=>x.path===source),receipt=s.private.deleteReceipt;if(!plugin.syncPaused||plugin.composition!==null||!receipt||!row||!row.deleted||row.etag!=='"'+receipt.epoch+'.'+receipt.rev+'"'||m.rows.some((x)=>x.path===placeholder)||j.base?.[source]?.deleted!==true||j.base[source].rev!==receipt.rev)throw Error("AC19P6_TOMBSTONE_MISSING");return safe("passed",{tombstoneObserved:true,placeholderAbsent:true,paused:true});});`;
		default:
			throw new Error("AC-19 phase has no host action");
	}
}

/** Builds the host-side phase code shared by each short, independently guarded evaluation. */
function createPhaseSource(
	phase: (typeof AC19_PHASES)[number],
	target: string,
	source: string,
	placeholder: string,
): string {
	const phaseValue = JSON.stringify(phase);
	const targetValue = JSON.stringify(target);
	const sourceValue = JSON.stringify(source);
	const placeholderValue = JSON.stringify(placeholder);
	const phaseList = JSON.stringify(AC19_PHASES);
	const phaseAction = ["preflight", "pause", "status"].includes(phase)
		? ""
		: createPhaseAction(phase);
	return `(async function(){
const v=app.vault,adapter=v.adapter;
if(v.getName()!=="obsidian-ai-bridge-dev-2"||typeof adapter.basePath!=="string"||!adapter.basePath.endsWith("/vaults/obsidian-ai-bridge-dev-2")||adapter.getBasePath()!==${targetValue})throw Error("AC19P6_TARGET");
const phase=${phaseValue},phases=${phaseList},source=${sourceValue},placeholder=${placeholderValue},key="__oabAc19P6",now=Date.now();
const plugin=app.plugins.plugins?.["vaultwire"];
const safe=(status,flags={})=>({phase,status,at:now,clientId:plugin?.journal?.snapshot?.().client_id??null,counts:counts(),attentionHash:s?.private?.attentionHash??null,flags,...(s?.taskState==="admission_limited"&&Number.isFinite(s.retryAfterUntil)?{retryAfterMs:Math.max(0,s.retryAfterUntil-now)}:{})});
const counts=()=>{const j=plugin?.journal?.snapshot?.();return j?{operations:j.pending_ops.length,applies:j.pending_apply.length,attention:j.attention.length,confirmations:j.coexistence_confirmations.length}:{operations:0,applies:0,attention:0,confirmations:0};};
const emit=(value)=>"OAB8AC19P6:"+JSON.stringify(value);
const fixedError=(error)=>{const text=String(error?.name??"");return text==="SyncTransportError"?"AC19P6_SERVICE_READ":"AC19P6_EFFECT_FAILED";};
const s=app[key];
if(phase==="pause"){
 if(!s)app[key]={version:1,source,placeholder,phase:"pause",issued:"pause",task:null,taskState:"paused",result:null,blockMutations:true,private:{}};
 const state=s??app[key];
 state.pauseRequested=true;
 state.blockMutations=true;
 if(state.task&&state.taskState==="pending"){state.unresolvedEffect=true;state.pausedTaskPhase=state.issued;}
 if(plugin?.settingsTab?.syncActions?.pause&&!plugin.syncPaused)plugin.settingsTab.syncActions.pause();
 const settled=Boolean(plugin?.syncPaused&&plugin.composition===null);
 if(settled){state.taskState="paused";state.phase="pause";state.result=safe("paused",{paused:true});}
 return emit(safe(settled?"paused":"pending",{paused:Boolean(plugin?.syncPaused)}));
}
if(phase==="preflight"){
 if(s||v.getAbstractFileByPath(source)||v.getAbstractFileByPath(placeholder)||await adapter.stat(source)||await adapter.stat(placeholder))throw Error("AC19P6_COLLISION");
 if(!plugin?.journal?.snapshot||!plugin.desktopSync||!plugin.settingsTab?.syncActions?.resume||!plugin.settingsTab?.syncActions?.pause||!plugin.coexistence)throw Error("AC19P6_HOST");
 const j=plugin.journal.snapshot();
 if(plugin.sessionStatus!=="connected"||!plugin.syncPaused||plugin.syncActive||plugin.composition!==null)throw Error("AC19P6_INITIAL_STATE");
 if(j.base?.[source]||j.base?.[placeholder]||j.pending_ops.some((x)=>x.path===source||x.to===source||x.path===placeholder||x.to===placeholder)||j.pending_apply.some((x)=>x.path===source||x.path===placeholder)||j.coexistence_confirmations.some((x)=>x.path===source||x.path===placeholder))throw Error("AC19P6_COLLISION");
 app[key]={version:1,source,placeholder,phase:"preflight",issued:null,task:null,result:null,blockMutations:false,private:{epoch:j.epoch,base:structuredClone(j.base),ops:structuredClone(j.pending_ops),applies:structuredClone(j.pending_apply),attention:structuredClone(j.attention),confirmations:structuredClone(j.coexistence_confirmations),authority:null,manifestReader:null,attentionHash:null}};
 const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(JSON.stringify(j.attention)));
 if(app[key].pauseRequested||app[key].blockMutations)return emit(safe("paused",{paused:Boolean(plugin?.syncPaused)}));
 app[key].private.attentionHash=Array.from(new Uint8Array(digest),(x)=>x.toString(16).padStart(2,"0")).join("");
 return emit(safe("ready",{paused:true,coexistence:Boolean(plugin.settingsValue?.coexistenceMode)}));
}
if(!s||s.version!==1||s.source!==source||s.placeholder!==placeholder)throw Error("AC19P6_STATE");
if(s.task&&s.taskState==="pending"&&now>s.taskDeadline){s.taskState="uncertain";s.blockMutations=true;}
if(phase==="status"){
 const status=s.taskState==="pending"||s.taskState==="admission_limited"?"pending":s.taskState==="uncertain"?"uncertain":s.taskState==="failed"?"failed":s.taskState==="paused"||s.phase==="pause"?"paused":s.result?.status??"ready";
 return emit(safe(status,s.result?.flags??{}));
}
if(s.blockMutations&&!["pause","service-final"].includes(phase))return emit(safe("paused",{paused:Boolean(plugin?.syncPaused)}));
if(s.task&&s.taskState==="pending")return emit(safe("pending",s.result?.flags??{}));
if(s.taskState==="uncertain")return emit(safe("uncertain",s.result?.flags??{}));
if(s.taskState==="failed")return emit(s.safeError?{phase,status:"failed",at:now}:safe("failed"));
const retryableRead=["service-absence","service-baseline","service-captured","service-restored","service-final"].includes(phase);
if(s.taskState==="admission_limited"&&s.issued===phase&&retryableRead){if(now<s.retryAfterUntil)return emit(safe("pending"));s.taskState=null;s.issued=null;s.retryAfterUntil=null;}
if(s.phase===phase)return emit(s.result??safe("passed"));
if(phases.indexOf(phase)!==phases.indexOf(s.phase)+1)throw Error("AC19P6_ORDER");
if(s.issued===phase)throw Error("AC19P6_DUPLICATE");
if(!plugin?.journal?.snapshot)throw Error("AC19P6_HOST");
const journal=plugin.journal;
const assertActive=()=>{if((s.pauseRequested||s.blockMutations)&&phase!=="service-final")throw Error("AC19P6_PAUSED");};
const snapshot=()=>journal.snapshot();
const same=(x,y)=>JSON.stringify(x)===JSON.stringify(y);
const current=()=>snapshot();
const waitFor=async(test,timeout=30000)=>{const deadline=Date.now()+timeout;while(Date.now()<deadline){if((s.pauseRequested||s.blockMutations)&&phase!=="service-final")return false;if(test())return true;await new Promise((resolve)=>window.setTimeout(resolve,50));}return !(s.pauseRequested||s.blockMutations)&&test();};
const startsEffect=()=>{s.issued=phase;s.taskState="pending";s.taskStartedAt=Date.now();s.taskDeadline=s.taskStartedAt+30000;};
if(s.task)return emit(safe("pending",s.result?.flags??{}));
const sourceExists=()=>Boolean(v.getAbstractFileByPath(source));
const captureHistory=(j)=>same(j.pending_ops,s.private.ops)&&same(j.pending_apply,s.private.applies)&&same(j.attention,s.private.attention)&&same(j.coexistence_confirmations.filter((x)=>x.path!==source&&x.path!==placeholder),s.private.confirmations)&&same(Object.fromEntries(Object.entries(j.base??{}).filter(([path])=>path!==source&&path!==placeholder)),Object.fromEntries(Object.entries(s.private.base??{}).filter(([path])=>path!==source&&path!==placeholder)));
const readManifest=async()=>{
 const reader=s.private.manifestReader;
 if(!reader||typeof reader.manifest!=="function")throw Error("AC19P6_MANIFEST_UNAVAILABLE");
 assertActive();
 let page=await reader.manifest(null);
 assertActive();
 const epoch=page.epoch,head=page.head_seq,rows=[];
 let pageCount=0;
 for(;;){
  if(Date.now()>s.taskDeadline||++pageCount>1000)throw Error("AC19P6_MANIFEST_BOUND");
  if(page.epoch!==epoch||page.head_seq!==head)throw Error("AC19P6_MANIFEST_CHANGED");
  for(const row of page.entries??[])if(row.path===source||row.path===placeholder)rows.push({path:row.path,etag:row.etag,seq:row.seq,hash:row.hash,kind:row.kind,deleted:row.deleted});
  if(page.next_page===null)break;
  assertActive();
  page=await reader.manifest(page.next_page);
  assertActive();
 }
 return {epoch,head,rows};
};
const start=(effect)=>{startsEffect();s.task=Promise.resolve().then(()=>{assertActive();return effect();}).then((value)=>{if(s.taskState!=="pending"||((s.pauseRequested||s.blockMutations)&&phase!=="service-final")){s.task=null;return;}s.taskState="passed";s.phase=phase;s.result=value;s.task=null;},(error)=>{if(s.taskState!=="pending"||((s.pauseRequested||s.blockMutations)&&phase!=="service-final")){s.task=null;return;}let retryAfter=null;try{if(error?.status===429&&typeof error.retryAfter==="string")retryAfter=error.retryAfter;}catch{}if(retryableRead&&retryAfter!==null){const seconds=/^(0|[1-9][0-9]*)$/.test(retryAfter)?Number(retryAfter):null,date=seconds===null?Date.parse(retryAfter):NaN,delay=seconds===null?date-Date.now():seconds*1000,validDate=Number.isFinite(date)&&new Date(date).toUTCString()===retryAfter;if(Number.isSafeInteger(seconds)&&seconds>=0&&delay<=300000||validDate&&delay>=0&&delay<=300000){s.retryAfterUntil=Date.now()+delay;s.taskState="admission_limited";s.task=null;return;}}s.taskError=fixedError(error);s.safeError=s.taskError;s.taskState="failed";s.phase=phase;s.result={phase,status:"failed",at:Date.now(),flags:{}};s.task=null;});return emit(safe("pending"));};
${phaseAction}
})()`;
}

/** Creates fixed, guarded, short evaluations for the single authorized P6 fixture. */
export function createAc19PhaseScripts(
	id: DesktopVaultId,
	resolvedPath: string,
	home?: string,
	fixtureName = "simulated-eviction-p6-20261106-01",
): Record<(typeof AC19_PHASES)[number], string> {
	if (id !== "dev-2") throw new Error("AC-19 service case requires dev-2");
	const target = authorizeTarget(id, resolvedPath, home);
	if (fixtureName !== "simulated-eviction-p6-20261106-01")
		throw new Error("AC-19 P6 fixture name is fixed");
	const fixture = fixedFixturePaths();
	const scripts = Object.fromEntries(
		AC19_PHASES.map((phase) => [
			phase,
			createPhaseSource(phase, target, fixture.source, fixture.placeholder),
		]),
	) as Record<(typeof AC19_PHASES)[number], string>;
	return scripts;
}

/** Checks one exact target, runs one short CLI evaluation, and projects safe output fields. */
export function runAc19Phase(
	id: DesktopVaultId,
	vaultName: string,
	script: string,
	options: {
		executable?: string;
		invoke?: (executable: string, args: readonly string[]) => Ac19CliResult;
	} = {},
): Ac19PhaseCheckpoint {
	const target = authorizeTarget(
		id,
		resolve(homedir(), "vaults/obsidian-ai-bridge-dev-2"),
	);
	if (id !== "dev-2" || vaultName !== "obsidian-ai-bridge-dev-2")
		throw new Error("Unauthorized AC-19 CLI target");
	const phaseMatch = script.match(/const phase=("[a-z-]+")/);
	if (!phaseMatch) throw new Error("AC-19 phase script is invalid");
	const requestedPhase = JSON.parse(
		phaseMatch[1],
	) as Ac19PhaseCheckpoint["phase"];
	if (!Object.values(createAc19PhaseScripts(id, target)).includes(script))
		throw new Error("Unauthorized AC-19 phase script");
	const executable = options.executable ?? "/opt/homebrew/bin/obsidian";
	const invoke =
		options.invoke ??
		((program, args) => {
			const result = spawnSync(program, args, {
				encoding: "utf8",
				timeout: 8_000,
			});
			return {
				status: result.status,
				stdout: result.stdout ?? "",
				spawnError: Boolean(result.error),
				signal: result.signal,
			};
		});
	let identity: Ac19CliResult;
	try {
		identity = invoke(executable, [`vault=${vaultName}`, "vault", "info=path"]);
	} catch {
		throw new Error("Obsidian vault identity check failed");
	}
	if (
		identity.spawnError ||
		identity.signal ||
		identity.status !== 0 ||
		identity.stdout.trim() !== target
	)
		throw new Error("Obsidian resolved an unauthorized vault path");
	let result: Ac19CliResult;
	try {
		result = invoke(executable, [
			`vault=${vaultName}`,
			"eval",
			`code=${script}`,
		]);
	} catch {
		return {
			phase: requestedPhase,
			status: "uncertain",
			at: Date.now(),
		};
	}
	/** Marks the phase uncertain when the CLI did not prove its result. */
	const uncertain = (): Ac19PhaseCheckpoint => ({
		phase: requestedPhase,
		status: "uncertain",
		at: Date.now(),
	});
	if (result.spawnError || result.signal || result.status !== 0)
		return uncertain();
	const recordLine = result.stdout
		.split(/\r?\n/)
		.map((line) => line.trim().replace(/^=>\s*/, ""))
		.find((line) => line.startsWith("OAB8AC19P6:"));
	if (!recordLine) return uncertain();
	let value: unknown;
	try {
		value = JSON.parse(recordLine.slice("OAB8AC19P6:".length));
	} catch {
		return uncertain();
	}
	if (!value || typeof value !== "object") return uncertain();
	const record = value as Record<string, unknown>;
	const statuses = [
		"ready",
		"pending",
		"passed",
		"failed",
		"paused",
		"uncertain",
	] as const;
	if (
		record.phase !== requestedPhase ||
		!AC19_PHASES.includes(record.phase as (typeof AC19_PHASES)[number]) ||
		!statuses.includes(record.status as (typeof statuses)[number])
	)
		return uncertain();
	const checkpoint: Ac19PhaseCheckpoint = {
		phase: record.phase as Ac19PhaseCheckpoint["phase"],
		status: record.status as Ac19PhaseCheckpoint["status"],
	};
	if (typeof record.at === "number" && Number.isFinite(record.at))
		checkpoint.at = record.at;
	if (
		typeof record.attentionHash === "string" &&
		/^[a-f0-9]{64}$/.test(record.attentionHash)
	)
		checkpoint.attentionHash = record.attentionHash;
	if (
		typeof record.clientId === "string" &&
		/^[A-Za-z0-9_-]{1,80}$/.test(record.clientId)
	)
		checkpoint.clientId = record.clientId;
	if (record.counts && typeof record.counts === "object") {
		const counts = record.counts as Record<string, unknown>;
		if (
			[
				counts.operations,
				counts.applies,
				counts.attention,
				counts.confirmations,
			].every((x) => Number.isSafeInteger(x) && Number(x) >= 0)
		)
			checkpoint.counts = {
				operations: Number(counts.operations),
				applies: Number(counts.applies),
				attention: Number(counts.attention),
				confirmations: Number(counts.confirmations),
			};
	}
	if (record.flags && typeof record.flags === "object") {
		const flags = record.flags as Record<string, unknown>;
		checkpoint.flags = Object.fromEntries(
			Object.entries(flags).filter(
				([key, item]) =>
					[
						"paused",
						"coexistence",
						"placeholderExcluded",
						"historyUnchanged",
						"serviceUnchanged",
						"tombstoneObserved",
						"placeholderAbsent",
					].includes(key) && typeof item === "boolean",
			),
		) as Ac19PhaseCheckpoint["flags"];
	}
	if (
		typeof record.retryAfterMs === "number" &&
		Number.isSafeInteger(record.retryAfterMs) &&
		record.retryAfterMs >= 0 &&
		record.retryAfterMs <= 300_000
	)
		checkpoint.retryAfterMs = record.retryAfterMs;
	return checkpoint;
}
