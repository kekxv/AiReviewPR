import { parseAIReviewResponse } from '../src/utils';
import { system_prompt_numbered } from '../src/index';

describe('Prompt vs Parser Consistency', () => {
  it('should verify that the System Prompt example format is parsable by the Parser', () => {
    // 1. 获取 System Prompt
    const prompt = system_prompt_numbered("English");
    
    // 2. 人工构建一个严格遵循 Prompt 指令的模拟 AI 响应
    // 我们模拟 Prompt 中要求的格式：
    const mockAiOutput = `
Here is a summary of the issues.

---
File: src/index.ts
Context: Line 10: + const error = true;
StartLine: 10
EndLine: 10
Comment: [Score: 4] This introduces a logic bug.
---
`;

    // 3. 尝试解析
    const parsed = parseAIReviewResponse(mockAiOutput);

    // 4. 验证解析结果
    expect(parsed.comments.length).toBeGreaterThan(0);
    expect(parsed.comments[0].path).toBe('src/index.ts');
    expect(parsed.comments[0].line).toBe(10);
    expect(parsed.comments[0].body).toContain('This introduces a logic bug');
  });

  it('should verify that the Parser accepts the exact keys defined in the Prompt', () => {
    const prompt = system_prompt_numbered("English");
    
    // 检查 Prompt 中是否包含解析器必须的关键字
    expect(prompt).toContain('File:');
    expect(prompt).toContain('StartLine:');
    expect(prompt).toContain('EndLine:');
    expect(prompt).toContain('Comment:');
    expect(prompt).toContain('---');
  });
});
