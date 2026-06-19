import { parsePartialJson } from "@langchain/core/output_parsers";
import { useStreamContext } from "@/providers/Stream";
import { AIMessage, Checkpoint, Message } from "@langchain/langgraph-sdk";
import { useStream } from "@langchain/langgraph-sdk/react";
import { getContentString } from "../utils";
import { BranchSwitcher, CommandBar } from "./shared";
import { MarkdownText } from "../markdown-text";
import { LoadExternalComponent } from "@langchain/langgraph-sdk/react-ui";
import { cn } from "@/lib/utils";
import { LoaderCircle } from "lucide-react";
import { ToolCalls, ToolResult } from "./tool-calls";
import { MessageContentComplex } from "@langchain/core/messages";
import { Fragment } from "react/jsx-runtime";
import { isAgentInboxInterruptSchema } from "@/lib/agent-inbox-interrupt";
import {
  getInterruptKeys,
  isInterruptResolved,
  takePendingResume,
  useResolvedInterruptsVersion,
} from "@/lib/resolved-interrupts";
import { useEffect } from "react";
import { ThreadView } from "../agent-inbox";
import { useQueryState, parseAsBoolean } from "nuqs";
import { GenericInterruptView } from "./generic-interrupt";
import { useArtifact } from "../artifact";

function CustomComponent({
  message,
  thread,
}: {
  message: Message;
  thread: ReturnType<typeof useStreamContext>;
}) {
  const artifact = useArtifact();
  const { values } = useStreamContext();
  const customComponents = values.ui?.filter(
    (ui) => ui.metadata?.message_id === message.id,
  );

  if (!customComponents?.length) return null;
  return (
    <Fragment key={message.id}>
      {customComponents.map((customComponent) => (
        <LoadExternalComponent
          key={customComponent.id}
          stream={thread as unknown as ReturnType<typeof useStream>}
          message={customComponent}
          meta={{ ui: customComponent, artifact }}
        />
      ))}
    </Fragment>
  );
}

function parseAnthropicStreamedToolCalls(
  content: MessageContentComplex[],
): AIMessage["tool_calls"] {
  const toolCallContents = content.filter((c) => c.type === "tool_use" && c.id);

  return toolCallContents.map((tc) => {
    const toolCall = tc as Record<string, any>;
    let json: Record<string, any> = {};
    if (toolCall?.input) {
      try {
        json = parsePartialJson(toolCall.input) ?? {};
      } catch {
        // Pass
      }
    }
    return {
      name: toolCall.name ?? "",
      id: toolCall.id ?? "",
      args: json,
      type: "tool_call",
    };
  });
}

interface InterruptProps {
  interrupt?: unknown;
  isLastMessage: boolean;
  hasNoAIOrToolMessages: boolean;
}

/**
 * Compact placeholder for interrupts the operator already answered but the
 * backend hasn't consumed yet: the resumed branch keeps streaming until its
 * next checkpoint, so thread.interrupt clears late. Shows the decision is in
 * flight instead of hiding the box abruptly; disappears on its own once
 * thread.interrupt advances past the answered interrupt.
 */
function AwaitingResumeNotice({
  interrupts,
}: {
  interrupts: Record<string, any>[];
}) {
  const names = interrupts
    .map((it) => it?.value?.action_requests?.[0]?.name)
    .filter((n): n is string => typeof n === "string");
  return (
    <div className="flex items-center gap-2 rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-500">
      <LoaderCircle className="size-4 shrink-0 animate-spin" />
      <span>
        Decision submitted
        {names.length > 0 ? ` (${names.join(", ")})` : ""} — waiting for the
        agent to resume…
      </span>
    </div>
  );
}

function Interrupt({
  interrupt,
  isLastMessage,
  hasNoAIOrToolMessages,
}: InterruptProps) {
  // Re-render whenever the answered-interrupt set changes so answered boxes
  // collapse immediately, even in the multi-interrupt case (see below) where
  // there is no single id to watch.
  useResolvedInterruptsVersion();

  // The "waiting for the agent to resume…" notice only makes sense while a run
  // is actually streaming. When the run is idle/finished, a resolved interrupt
  // still lingering in thread.interrupt is stale — there is no agent to resume —
  // so showing a perpetual spinner is wrong (e.g. after a reload of a completed
  // run). Gate the notice on the live-stream flag.
  const stream = useStreamContext();
  const { isLoading } = stream;

  // thread.interrupt is a single Interrupt when one is pending, but an ARRAY
  // when several sub-agents interrupt at once. Normalize to a list either way.
  const interruptList: Record<string, any>[] = Array.isArray(interrupt)
    ? (interrupt as Record<string, any>[])
    : interrupt
      ? [interrupt as Record<string, any>]
      : [];

  // Split the interrupts the operator already answered this session from the
  // ones still awaiting a decision. Without this the answered box lingers
  // interactively until thread.interrupt advances (which lags while other
  // agents keep streaming); and with multiple pending interrupts, splitting
  // here surfaces the next unanswered one immediately from local state instead
  // of waiting for the next worker's request to refresh the SDK. Answered ones
  // still reported by the backend render as a compact "in flight" notice.
  const pending: Record<string, any>[] = [];
  const awaitingBackend: Record<string, any>[] = [];
  for (const it of interruptList) {
    if (isInterruptResolved(getInterruptKeys(it))) {
      awaitingBackend.push(it);
    } else {
      pending.push(it);
    }
  }

  // Centralized, DEFERRED resume. The per-interrupt action handlers only RECORD
  // their decision (recordResumeDecision) and mark the box resolved; the actual
  // Command(resume=…) is fired here, exactly once, and only after EVERY currently
  // pending gate in this wave has been answered (pending empty, interrupts still
  // present). Submitting per-approval instead re-runs the not-yet-answered sibling
  // Send tasks — whose interrupt id is derived from the superstep they run at, so it
  // SHIFTS — and the later approval (keyed by the stale id) then matches nothing and
  // its gated tool never fires (the "drop rules never created" symptom). Resuming the
  // whole wave in one invocation is the path the backend handles cleanly (verified:
  // a 3-interrupt single-shot resume succeeds). takePendingResume() is idempotent, so
  // re-renders / a resolved box lingering in thread.interrupt never double-submit, and
  // only the active (last-message) instance owns the submit.
  const isActiveInterruptView = isLastMessage || hasNoAIOrToolMessages;
  const waveFullyAnswered = interruptList.length > 0 && pending.length === 0;
  useEffect(() => {
    if (!isActiveInterruptView || !waveFullyAnswered) return;
    const resume = takePendingResume();
    if (!resume) return;
    stream.submit(null, {
      command: { resume },
      streamMode: ["values"],
      streamSubgraphs: true,
    });
  }, [isActiveInterruptView, waveFullyAnswered, stream]);

  if (!(isLastMessage || hasNoAIOrToolMessages)) return null;
  if (interruptList.length === 0) return null;

  let pendingView: React.ReactNode = null;
  if (pending.length > 0) {
    if (isAgentInboxInterruptSchema(pending)) {
      pendingView = <ThreadView interrupt={pending} />;
    } else {
      const first = pending[0];
      const fallbackValue = ((first as { value?: unknown }).value ??
        first) as Record<string, any>;
      pendingView = <GenericInterruptView interrupt={fallbackValue} />;
    }
  }

  return (
    <>
      {pendingView}
      {isLoading && awaitingBackend.length > 0 && (
        <AwaitingResumeNotice interrupts={awaitingBackend} />
      )}
    </>
  );
}

export function AssistantMessage({
  message,
  isLoading,
  handleRegenerate,
}: {
  message: Message | undefined;
  isLoading: boolean;
  handleRegenerate: (parentCheckpoint: Checkpoint | null | undefined) => void;
}) {
  const content = message?.content ?? [];
  const contentString = getContentString(content);
  const [hideToolCalls] = useQueryState(
    "hideToolCalls",
    parseAsBoolean.withDefault(false),
  );

  const thread = useStreamContext();
  const isLastMessage =
    thread.messages[thread.messages.length - 1].id === message?.id;
  const hasNoAIOrToolMessages = !thread.messages.find(
    (m) => m.type === "ai" || m.type === "tool",
  );
  const meta = message ? thread.getMessagesMetadata(message) : undefined;
  const threadInterrupt = thread.interrupt;

  const parentCheckpoint = meta?.firstSeenState?.parent_checkpoint;
  const anthropicStreamedToolCalls = Array.isArray(content)
    ? parseAnthropicStreamedToolCalls(content)
    : undefined;

  const hasToolCalls =
    message &&
    "tool_calls" in message &&
    message.tool_calls &&
    message.tool_calls.length > 0;
  const toolCallsHaveContents =
    hasToolCalls &&
    message.tool_calls?.some(
      (tc) => tc.args && Object.keys(tc.args).length > 0,
    );
  const hasAnthropicToolCalls = !!anthropicStreamedToolCalls?.length;
  const isToolResult = message?.type === "tool";

  if (isToolResult && hideToolCalls) {
    return null;
  }

  return (
    <div className="group mr-auto flex w-full items-start gap-2">
      <div className="flex w-full flex-col gap-2">
        {isToolResult ? (
          <>
            <ToolResult message={message} />
            <Interrupt
              interrupt={threadInterrupt}
              isLastMessage={isLastMessage}
              hasNoAIOrToolMessages={hasNoAIOrToolMessages}
            />
          </>
        ) : (
          <>
            {contentString.length > 0 && (
              <div className="py-1">
                <MarkdownText>{contentString}</MarkdownText>
              </div>
            )}

            {!hideToolCalls && (
              <>
                {(hasToolCalls && toolCallsHaveContents && (
                  <ToolCalls toolCalls={message.tool_calls} />
                )) ||
                  (hasAnthropicToolCalls && (
                    <ToolCalls toolCalls={anthropicStreamedToolCalls} />
                  )) ||
                  (hasToolCalls && (
                    <ToolCalls toolCalls={message.tool_calls} />
                  ))}
              </>
            )}

            {message && (
              <CustomComponent
                message={message}
                thread={thread}
              />
            )}
            <Interrupt
              interrupt={threadInterrupt}
              isLastMessage={isLastMessage}
              hasNoAIOrToolMessages={hasNoAIOrToolMessages}
            />
            <div
              className={cn(
                "mr-auto flex items-center gap-2 transition-opacity",
                "opacity-0 group-focus-within:opacity-100 group-hover:opacity-100",
              )}
            >
              <BranchSwitcher
                branch={meta?.branch}
                branchOptions={meta?.branchOptions}
                onSelect={(branch) => thread.setBranch(branch)}
                isLoading={isLoading}
              />
              <CommandBar
                content={contentString}
                isLoading={isLoading}
                isAiMessage={true}
                handleRegenerate={() => handleRegenerate(parentCheckpoint)}
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export function AssistantMessageLoading() {
  return (
    <div className="mr-auto flex items-start gap-2">
      <div className="bg-muted flex h-8 items-center gap-1 rounded-2xl px-4 py-2">
        <div className="bg-foreground/50 h-1.5 w-1.5 animate-[pulse_1.5s_ease-in-out_infinite] rounded-full"></div>
        <div className="bg-foreground/50 h-1.5 w-1.5 animate-[pulse_1.5s_ease-in-out_0.5s_infinite] rounded-full"></div>
        <div className="bg-foreground/50 h-1.5 w-1.5 animate-[pulse_1.5s_ease-in-out_1s_infinite] rounded-full"></div>
      </div>
    </div>
  );
}
