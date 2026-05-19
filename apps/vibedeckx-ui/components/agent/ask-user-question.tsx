"use client";

import { useState } from "react";
import { useAgentConversation } from "./agent-conversation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { CheckCircle2, HelpCircle, Loader2 } from "lucide-react";

interface QuestionOption {
  label: string;
  description: string;
}

interface Question {
  question: string;
  header: string;
  options: QuestionOption[];
  multiSelect: boolean;
}

interface AskUserQuestionInput {
  questions: Question[];
}

function parseInput(input: unknown): AskUserQuestionInput | null {
  try {
    const obj = (typeof input === "string" ? JSON.parse(input) : input) as Record<string, unknown>;
    if (
      obj &&
      Array.isArray(obj.questions) &&
      obj.questions.length > 0 &&
      obj.questions.every(
        (q: Record<string, unknown>) =>
          typeof q.question === "string" &&
          typeof q.header === "string" &&
          Array.isArray(q.options)
      )
    ) {
      return obj as unknown as AskUserQuestionInput;
    }
  } catch {
    // fall through
  }
  return null;
}

interface AskUserQuestionProps {
  input: unknown;
  messageIndex: number;
}

export function AskUserQuestion({ input, messageIndex }: AskUserQuestionProps) {
  const { sendMessage, messages } = useAgentConversation();
  const parsed = parseInput(input);

  // Determine if already answered: next message is a user message
  const nextMsg = messages[messageIndex + 1];
  const isAnswered = nextMsg?.type === "user";
  const rawContent = isAnswered ? nextMsg.content : "";
  const answeredText = typeof rawContent === "string" ? rawContent : rawContent.filter(p => p.type === "text").map(p => p.text).join("\n");

  if (!parsed) {
    // Fallback: render raw JSON
    const inputStr = typeof input === "string" ? input : JSON.stringify(input, null, 2);
    return (
      <pre
        className="mt-1 bg-muted/50 p-2 rounded overflow-x-auto max-w-full whitespace-pre-wrap break-all"
        style={{ fontSize: "var(--conv-font-size, 12px)" }}
      >
        {inputStr.length > 500 ? inputStr.substring(0, 500) + "..." : inputStr}
      </pre>
    );
  }

  if (isAnswered) {
    return <AnsweredView questions={parsed.questions} answeredText={answeredText} />;
  }

  return <InteractiveView questions={parsed.questions} sendMessage={sendMessage} />;
}

function AnsweredView({
  questions,
  answeredText,
}: {
  questions: Question[];
  answeredText: string;
}) {
  return (
    <div className="space-y-3 mt-2">
      {questions.map((q, qi) => (
        <div key={qi} className="rounded-lg border bg-muted/30 p-3">
          <div className="flex items-center gap-2 mb-1.5">
            <Badge variant="secondary" className="text-[10px]">
              {q.header}
            </Badge>
          </div>
          <p className="text-sm text-muted-foreground mb-2">{q.question}</p>
          <div className="flex items-center gap-2 text-sm text-green-600 dark:text-green-400">
            <CheckCircle2 className="h-4 w-4" />
            <span className="font-medium">{answeredText}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

function InteractiveView({
  questions,
  sendMessage,
}: {
  questions: Question[];
  sendMessage: (content: string, sessionId?: string) => Promise<void>;
}) {
  // Track selection state per question
  const [selections, setSelections] = useState<Map<number, Set<string>>>(new Map());
  const [otherTexts, setOtherTexts] = useState<Map<number, string>>(new Map());
  const [usingOther, setUsingOther] = useState<Set<number>>(new Set());
  const [submitting, setSubmitting] = useState(false);

  function toggleOption(qIndex: number, label: string, multiSelect: boolean) {
    setSelections((prev) => {
      const next = new Map(prev);
      const current = new Set(next.get(qIndex) || []);
      if (multiSelect) {
        if (current.has(label)) current.delete(label);
        else current.add(label);
      } else {
        if (current.has(label)) current.clear();
        else {
          current.clear();
          current.add(label);
        }
      }
      next.set(qIndex, current);
      return next;
    });
    // Deselect "other" when picking a regular option
    setUsingOther((prev) => {
      const next = new Set(prev);
      next.delete(qIndex);
      return next;
    });
  }

  function setOtherText(qIndex: number, text: string) {
    setOtherTexts((prev) => new Map(prev).set(qIndex, text));
    // Clear regular selections when typing in Other
    if (text) {
      setSelections((prev) => {
        const next = new Map(prev);
        next.set(qIndex, new Set());
        return next;
      });
      setUsingOther((prev) => new Set(prev).add(qIndex));
    }
  }

  async function handleSubmit() {
    const answers: string[] = [];
    for (let qi = 0; qi < questions.length; qi++) {
      if (usingOther.has(qi)) {
        const text = otherTexts.get(qi)?.trim();
        if (text) answers.push(text);
      } else {
        const selected = selections.get(qi);
        if (selected && selected.size > 0) {
          answers.push(Array.from(selected).join(", "));
        }
      }
    }
    if (answers.length > 0) {
      setSubmitting(true);
      try {
        await sendMessage(answers.join("\n"));
      } finally {
        setSubmitting(false);
      }
    }
  }

  const hasAnswer = questions.some((_, qi) => {
    if (usingOther.has(qi)) return !!otherTexts.get(qi)?.trim();
    const s = selections.get(qi);
    return s && s.size > 0;
  });

  return (
    <div className="space-y-4 mt-2">
      {questions.map((q, qi) => {
        const selected = selections.get(qi) || new Set<string>();
        const otherText = otherTexts.get(qi) || "";
        const isOther = usingOther.has(qi);

        return (
          <div key={qi} className="rounded-lg border bg-card p-3">
            <div className="flex items-center gap-2 mb-1.5">
              <HelpCircle className="h-3.5 w-3.5 text-violet-500" />
              <Badge variant="secondary" className="text-[10px]">
                {q.header}
              </Badge>
            </div>
            <p className="text-sm font-medium mb-3">{q.question}</p>
            <div className="grid gap-2">
              {q.options.map((opt) => {
                const isSelected = selected.has(opt.label) && !isOther;
                return (
                  <Button
                    key={opt.label}
                    variant={isSelected ? "default" : "outline"}
                    className={cn(
                      "h-auto py-2 px-3 justify-start text-left whitespace-normal",
                      isSelected && "ring-2 ring-primary/50"
                    )}
                    onClick={() => toggleOption(qi, opt.label, q.multiSelect)}
                  >
                    <div>
                      <span className="font-medium text-sm">{opt.label}</span>
                      {opt.description && (
                        <span className="block text-xs text-muted-foreground mt-0.5">
                          {opt.description}
                        </span>
                      )}
                    </div>
                  </Button>
                );
              })}
              {/* Other option */}
              <div className="flex items-center gap-2 mt-1">
                <Input
                  placeholder="Other..."
                  value={otherText}
                  onChange={(e) => setOtherText(qi, e.target.value)}
                  className="text-sm"
                />
              </div>
            </div>
          </div>
        );
      })}
      <Button
        onClick={handleSubmit}
        disabled={!hasAnswer || submitting}
        size="sm"
        className="active:scale-95 transition-transform"
      >
        {submitting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
        {submitting ? "Submitting..." : "Submit"}
      </Button>
    </div>
  );
}
