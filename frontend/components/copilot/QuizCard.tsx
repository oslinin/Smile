"use client";

// Interactive quiz card rendered from a quiz_question tool call. The user's
// pick is sent back as the tool output so the model can react (explain, keep
// score, offer the next question).

export interface QuizAnswer {
  picked: number;
  correct: boolean;
}

export function QuizCard({
  question,
  choices,
  correctIndex,
  explanation,
  topic,
  answer,
  onAnswer,
}: {
  question: string;
  choices: string[];
  correctIndex: number;
  explanation: string;
  topic: string;
  /** Present once answered (from the tool output). */
  answer?: QuizAnswer;
  onAnswer?: (a: QuizAnswer) => void;
}) {
  const answered = answer !== undefined;

  return (
    <div className="rounded-lg border border-purple-900/60 bg-gray-900 p-3 space-y-2 my-1">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] text-purple-400 uppercase tracking-wide">quiz · {topic}</span>
        {answered && (
          <span className={`text-[10px] font-semibold ${answer.correct ? "text-green-400" : "text-red-400"}`}>
            {answer.correct ? "✓ correct" : "✗ incorrect"}
          </span>
        )}
      </div>
      <p className="text-sm text-gray-200">{question}</p>
      <div className="space-y-1">
        {choices.map((choice, i) => {
          const isPicked = answered && answer.picked === i;
          const isCorrect = answered && i === correctIndex;
          return (
            <button
              key={i}
              disabled={answered}
              onClick={() => onAnswer?.({ picked: i, correct: i === correctIndex })}
              className={`w-full text-left text-xs px-3 py-2 rounded border transition-colors ${
                isCorrect
                  ? "border-green-600 bg-green-900/30 text-green-300"
                  : isPicked
                    ? "border-red-600 bg-red-900/30 text-red-300"
                    : answered
                      ? "border-gray-800 bg-gray-950 text-gray-500"
                      : "border-gray-700 bg-gray-950 text-gray-300 hover:border-purple-600 hover:text-white cursor-pointer"
              }`}
            >
              <span className="text-gray-600 mr-2">{String.fromCharCode(65 + i)}.</span>
              {choice}
            </button>
          );
        })}
      </div>
      {answered && <p className="text-xs text-gray-400 border-t border-gray-800 pt-2">{explanation}</p>}
    </div>
  );
}
