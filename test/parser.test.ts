import {parseAIReviewResponse} from "../src/utils";

describe('parseAIReviewResponse', () => {

  // 测试用例 1: 标准输出（包含 Summary 和 1 个 Issue）
  it('should parse standard output with summary and one issue', () => {
    const input = `
Here is a summary of the changes.

---
File: src/main.ts
Context: Line 10: + const a = 1;
StartLine: 10
EndLine: 10
Comment: [Score: 3] Avoid using magic numbers.
---
`;
    const result = parseAIReviewResponse(input);

    expect(result.body).toBe('Here is a summary of the changes.');
    expect(result.comments).toHaveLength(1);
    expect(result.comments[0]).toEqual({
      path: 'src/main.ts',
      line: 10,
      start_line: undefined, // 单行评论不需要 start_line
      body: '[Score: 3] Avoid using magic numbers.'
    });
  });

  // 测试用例 2: 深度思考模型过滤 (<think> 标签)
  it('should remove <think> tags from reasoning models like DeepSeek', () => {
    const input = `
<think>
Checking syntax...
Found an issue in auth.ts
</think>
Review Summary.
---
File: src/auth.ts
StartLine: 5
EndLine: 5
Comment: [Score: 5] Critical error.
---
`;
    const result = parseAIReviewResponse(input);

    expect(result.body).toBe('Review Summary.'); // 确保 <think> 内容没有泄露到 body
    expect(result.comments).toHaveLength(1);
    expect(result.comments[0].path).toBe('src/auth.ts');
  });

  // 测试用例 3: LGTM (无 Issue)
  it('should handle LGTM correctly', () => {
    const input = `
Code looks clean. Logic is sound.
LGTM
`;
    const result = parseAIReviewResponse(input);

    expect(result.body).toBe('Code looks clean. Logic is sound.');
    expect(result.comments).toHaveLength(0);
  });

  // 测试用例 4: 多行评论 & 范围评论 (StartLine != EndLine)
  it('should handle multi-line comments and line ranges', () => {
    const input = `
Summary...
---
File: src/utils.ts
StartLine: 10
EndLine: 15
Comment: [Score: 2] 
This function is too complex.
Please refactor it into smaller pieces.
---
`;
    const result = parseAIReviewResponse(input);

    expect(result.comments[0]).toEqual({
      path: 'src/utils.ts',
      line: 15,
      start_line: 10, // 范围评论应该有 start_line
      body: '[Score: 2] \nThis function is too complex.\nPlease refactor it into smaller pieces.'
    });
  });

  // 测试用例 5: 兼容中文 Key 和 格式容错
  it('should be robust with Chinese keys and messy spacing', () => {
    const input = `
中文总结
---
文件： src/api.js 
起始行号： 20
结束行号： 20
评论： [Score: 1] 建议修改变量名
---
`;
    const result = parseAIReviewResponse(input);

    expect(result.body).toBe('中文总结');
    expect(result.comments[0]).toEqual({
      path: 'src/api.js',
      line: 20,
      start_line: undefined,
      body: '[Score: 1] 建议修改变量名'
    });
  });

  // 测试用例 6: 多个 Issue
  it('should parse multiple issues correctly', () => {
    const input = `
Summary
---
File: a.ts
EndLine: 1
Comment: Error A
---
File: b.ts
EndLine: 2
Comment: Error B
---
`;
    const result = parseAIReviewResponse(input);

    expect(result.comments).toHaveLength(2);
    expect(result.comments[0].body).toBe('Error A');
    expect(result.comments[1].body).toBe('Error B');
  });

  // 测试用例 7: 缺少 StartLine (兼容性测试)
  it('should default start_line to end_line if missing', () => {
    const input = `
---
File: test.ts
EndLine: 50
Comment: Missing start line test
---
`;
    const result = parseAIReviewResponse(input);
    expect(result.comments[0].line).toBe(50);
    expect(result.comments[0].start_line).toBeUndefined();
  });
});
