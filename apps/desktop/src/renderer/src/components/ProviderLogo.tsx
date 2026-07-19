import anthropicLogo from "@renderer/assets/providers/anthropic.svg";
import claudeLogo from "@renderer/assets/providers/claude.svg";
import lmStudioLogo from "@renderer/assets/providers/lmstudio.svg";
import ollamaLogo from "@renderer/assets/providers/ollama.svg";
import openAiLogo from "@renderer/assets/providers/openai.svg";
import openRouterLogo from "@renderer/assets/providers/openrouter.svg";

const LOGOS: Record<string, string> = {
  "claude-sub": claudeLogo,
  anthropic: anthropicLogo,
  "chatgpt-sub": openAiLogo,
  openai: openAiLogo,
  openrouter: openRouterLogo,
  ollama: ollamaLogo,
  lmstudio: lmStudioLogo,
};

export function ProviderLogo({ id, className = "" }: { id: string; className?: string }) {
  const logo = LOGOS[id];
  if (logo) {
    return (
      <span
        className={`provider-logo${className ? ` ${className}` : ""}`}
        style={{ maskImage: `url(${logo})`, WebkitMaskImage: `url(${logo})` }}
        aria-hidden
      />
    );
  }
  return <span className={`provider-logo provider-logo-symbol${className ? ` ${className}` : ""}`} aria-hidden>⌘</span>;
}
