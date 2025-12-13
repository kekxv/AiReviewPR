import http from "http";
import https from "https";

export function split_message(files: string): string[] {
  files = files || "";
  let n = files.includes('\n') || files.includes('\r');
  files = files.trim()
  let res: string[] = [];
  if (files) {
    if (n) {
      res = files.split(/[\r\n]/);
    } else {
      res = files.split(",")
    }
  }
  return res.map(str => str.trim()).filter(item => item !== null && item !== undefined && item !== "")
}

export function doesAnyPatternMatch(patterns: Array<string>, str: string) {
  // 遍历正则表达式数组
  return patterns.some(pattern => {
    // 创建正则表达式对象，匹配模式
    const regex = new RegExp(pattern);
    // 测试字符串是否与正则表达式匹配
    return regex.test(str);
  });
}

/**
 * post data
 * @param url url
 * @param body post data
 * @param header post header
 * @param json is json res
 */
export async function post({url, body, header, json}: any): Promise<string> {
  return new Promise((resolve, reject) => {
    json = typeof json === "boolean" ? json : true;
    const data = typeof body === "string" ? body : JSON.stringify(body);
    let url_ = new URL(url);
    header = header || {};
    header['Content-Type'] = header['Content-Type'] || 'application/json';
    header['Content-Length'] = Buffer.byteLength(data)
    const options = {
      hostname: url_.hostname, // 确保去掉协议部分
      port: url_.port || (url_.protocol === "http:" ? 80 : 443),
      path: url_.pathname + (url_.search || ''),
      method: 'POST',
      headers: header
    };

    console.log(`[DEBUG] Sending POST request to: ${url}`);

    // noinspection DuplicatedCode
    const req = (url_.protocol === "http:" ? http : https).request(options, (res) => {
      console.log(`[DEBUG] Response received. Status Code: ${res.statusCode}`);
      let responseBody = '';

      // 根据 Content-Type 头获取字符编码
      const contentType = res.headers['content-type'];
      let charset: BufferEncoding = 'utf-8'; // 默认字符编码

      // 解析 Content-Type 以获取编码，如果有指定编码
      if (contentType) {
        const match = contentType.match(/charset=([\w-]+)/i);
        if (match) {
          if (match[1].toLowerCase() === 'utf-8') {
            charset = 'utf-8';
          } else if (match[1].toLowerCase() === 'gbk') {
            charset = 'ascii';
          } else if (match[1].toLowerCase() === 'ascii') {
            charset = 'ascii';
          } else {
            charset = 'utf-8'; // 默认字符编码
          }
        }
      }
      res.setEncoding(charset);

      res.on('data', (chunk) => {
        responseBody += chunk;
      });

      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`Request failed with status ${res.statusCode}: ${responseBody}`));
          return;
        }

        try {
          if (json) {
            if (!responseBody.trim()) {
               reject(new Error('Received empty response body'));
               return;
            }
            resolve(JSON.parse(responseBody));
          } else {
            resolve(responseBody);
          }
        } catch (error: any) {
          reject(new Error('Failed to parse : \'' + responseBody + '\'' + ' with error: ' + error.message));
        }
      });
    });

    req.on('error', (error) => {
      reject(new Error(`Request failed: ${error.message}`));
    });

    req.write(data);
    req.end();
  });
}
