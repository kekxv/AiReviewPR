import { execSync } from 'child_process';
import * as fs from 'fs';
import { 
  aiGenerate, 
  system_prompt_numbered,
  addLineNumbersToDiff
} from '../src/index';

/**
 * 本地测试脚本
 * 使用方法: 
 * npx ts-node test/local_run.ts --file <文件路径> --call
 */

async function runLocalTest() {
  const args = process.argv.slice(2);
  const fileIdx = args.indexOf('--file');
  const shouldCallAI = args.includes('--call');

  if (fileIdx === -1 || !args[fileIdx + 1]) {
    console.error("用法: npx ts-node test/local_run.ts --file <文件路径> [--call]");
    process.exit(1);
  }

  const filePath = args[fileIdx + 1];

  // 1. 获取 Git Diff
  let diffContext = "";
  try {
    diffContext = execSync(`git diff --unified=9999 HEAD -- "${filePath}"`, { encoding: 'utf-8' });
    if (!diffContext.trim()) {
      diffContext = execSync(`git diff --unified=9999 HEAD~1 HEAD -- "${filePath}"`, { encoding: 'utf-8' });
    }
  } catch (e) {
    console.warn("[WARN] Git diff failed, using empty diff.");
  }

  const numberedDiff = diffContext.trim() ? addLineNumbersToDiff(diffContext) : "No changes detected.";
  
  // 3. 构建 Prompt
  const language = process.env.INPUT_LANGUAGE || process.env.LANGUAGE || "Chinese";
  const systemPrompt = system_prompt_numbered(language);
  
  const userPrompt = `
Review the following <git_diff> and output issues in the specified format. If no issues, output "LGTM".

<git_diff>
${numberedDiff}
</git_diff>
`;

  console.log("\n" + "=".repeat(30) + " FULL PROMPT " + "=".repeat(30));
  console.log("\n[SYSTEM]:\n", systemPrompt);
  console.log("\n[USER]:\n", userPrompt);
  console.log("=".repeat(73) + "\n");

  if (shouldCallAI) {
    const host = process.env.INPUT_HOST;
    const token = process.env.INPUT_AI_TOKEN || "";
    const model = process.env.INPUT_MODEL;

    console.log("\n[INFO] Calling AI Service...");
    try {
      const content = await aiGenerate({
        host,
        token,
        model,
        prompt: userPrompt,
        system: systemPrompt
      });
      console.log("\n[DONE] Response received.");
    } catch (e: any) {
      console.error("[ERROR] AI call failed:", e.message);
    }
  }
}

runLocalTest().catch(err => {
  console.error(err);
  process.exit(1);
});
