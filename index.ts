import storeService from "@/service/storage";
import loginModal from "./login-modal";

// 保存原始的 XMLHttpRequest 方法，便于后续恢复原始行为
const originalSend = window.XMLHttpRequest.prototype.send;
const originalOpen = window.XMLHttpRequest.prototype.open;
const setRequestHeader = window.XMLHttpRequest.prototype.setRequestHeader;

// 定义 open 方法参数的接口
interface OpenParams {
  method: string; // 请求方法 (GET, POST 等)
  url: string | URL; // 请求 URL
  async?: boolean; // 是否异步
  username?: string | null; // 用户名
  password?: string | null; // 密码
}

// 扩展 XMLHttpRequest 以支持额外的功能
interface XMLHttpRequestPlus extends XMLHttpRequest {
  openParams: OpenParams; // 保存 open 方法的参数
  retryCount: number; // 记录重试次数
  __headers: Record<string, string>; // 保存请求头
}

// 定义白名单项的接口
interface WhiteList {
  method: string; // 请求方法
  url: string | URL; // 请求 URL
}
/** 确认函数，返回一个 Promise */
export type OnConfirm = () => Promise<void>;

export interface Config {
  /** 确认函数，返回一个 Promise */
  onConfirm: OnConfirm;
  /** 最大重试次数 */
  retryCount: number;
  /** 拦截的 HTTP 状态码 */
  interceptStatusCodes: number[];
  /** 白名单 */
  whiteList: WhiteList[];
}

// 默认配置
const defaultConfig: Config = {
  onConfirm: () => Promise.resolve(), // 默认的登录弹框逻辑
  retryCount: 3, // 默认最大重试次数
  interceptStatusCodes: [401], // 默认拦截 401 状态码
  whiteList: [], // 默认没有白名单
};

// 保存运行时的配置
let runtimeConfig: Config = { ...defaultConfig };

const pendingAuthPromises: Promise<boolean>[] = []; // 保存所有 401 的 Promise
let loginPromise: Promise<boolean> | null = null; // 保存登录弹框的 Promise

/**
 * 判断是否在白名单中
 * @param method 请求方法
 * @param url 请求 URL
 * @returns 是否在白名单中
 */
function isInWhiteList(method: string, url: string | URL): boolean {
  return runtimeConfig.whiteList.some(
    (item) => item.method === method.toLowerCase() && item.url === url
  );
}

/**
 * 处理 401 响应
 * @param rest send 方法的参数
 * @param funName 要调用的回调方法名
 * @param fun 回调方法
 * @param onConfirm 登录等待回调，处理登录完成后的逻辑
 */
function handleUnauthorizedResponse(
  this: XMLHttpRequestPlus,
  rest: (Document | XMLHttpRequestBodyInit | null | undefined)[],
  funName: "onloadend" | "onreadystatechange",
  fun: any,
  onConfirm: OnConfirm
) {
  // 如果 loginPromise 不存在，则创建登录弹框 Promise
  if (!loginPromise) {
    loginPromise = new Promise((resolve) => {
      onConfirm().then(
        () => {
          Promise.all(pendingAuthPromises); // 等待所有挂起的 Promise
          resolve(true);
          loginPromise = null;
          pendingAuthPromises.length = 0; // 清空挂起列表
        },
        () => {
          loginPromise = null;
          pendingAuthPromises.length = 0; // 清空挂起列表
        }
      );
    });
  }

  // 创建重试 Promise
  const retryPromise = new Promise<boolean>((resolve) => {
    loginPromise?.then(() => {
      const params = this.openParams; // 获取 open 方法的参数
      this.open(
        params.method,
        params.url,
        !!params.async,
        params.username,
        params.password
      );

      // 更新请求头，设置 Token
      const token = storeService.getToken() ?? "";
      const tokenName = storeService.getTokenName() || "x-token-id";
      Object.entries(this.__headers).forEach(([key, value]) => {
        if (![tokenName].includes(key)) {
          this.setRequestHeader(key, value); // 原始头部设置
        } else {
          this.setRequestHeader(key, token); // 替换为最新 Token
        }
      });

      // 如果未超过最大重试次数，则重新发送请求
      const retryCount = this.retryCount;
      if (retryCount < runtimeConfig.retryCount) {
        return;
      }
      this.retryCount = retryCount ? retryCount + 1 : 1;
      this.send(...rest);

      // 重新绑定回调并处理逻辑
      this[funName] = function (ev) {
        fun?.call(this, ev);
        resolve(true); // 重试成功
      };
    });
  });

  // 将重试 Promise 添加到挂起列表
  pendingAuthPromises.push(retryPromise);
}

/**
 * 通用响应处理函数
 * @param ev 事件对象
 * @param fun 回调函数
 * @param funName 回调函数名
 * @param rest send 方法的参数
 * @param onConfirm 登录等待回调，处理登录完成后的逻辑
 */
function handleInterceptResponse(
  this: XMLHttpRequestPlus,
  ev: ProgressEvent | Event,
  fun: any,
  funName: "onloadend" | "onreadystatechange",
  rest: (Document | XMLHttpRequestBodyInit | null | undefined)[],
  onConfirm: OnConfirm
) {
  // 判断响应是否为 JSON 格式
  const isJsonResponse =
    this.getResponseHeader("content-type")?.split(";")[0] ===
    "application/json";

  const openParams = this.openParams; // 获取 open 方法的参数
  const isWhiteList = isInWhiteList(openParams.method, openParams.url); // 是否在白名单

  // 如果是白名单，清空登录状态
  if (isWhiteList) {
    loginPromise = null;
    pendingAuthPromises.length = 0;
  }

  // 如果是 JSON 格式并且不在白名单中，处理 401
  if (isJsonResponse && !isWhiteList) {
    try {
      const response = JSON.parse(this.responseText);
      if (runtimeConfig.interceptStatusCodes.includes(Number(response.code))) {
        handleUnauthorizedResponse.call(this, rest, funName, fun, onConfirm);
        return;
      }
    } catch (error) {
      console.log(error);
    }
  }

  // 执行原始回调函数
  fun?.call(this, ev);
}

/**
 * 启动函数，拦截 XMLHttpRequest
 */
function setup(config: Partial<Config>) {
  runtimeConfig = { ...runtimeConfig, ...config };
  const onConfirm = runtimeConfig.onConfirm;
  // 重写 open 方法，保存参数
  window.XMLHttpRequest.prototype.open = function (
    method,
    url,
    async?: boolean,
    username?: string | null,
    password?: string | null
  ) {
    const xhr = this as XMLHttpRequestPlus;
    xhr.openParams = {
      method,
      url,
      async,
      username,
      password,
    };
    return originalOpen.call(this, method, url, async!, username, password);
  };

  // 重写 setRequestHeader 方法，记录请求头
  window.XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    const xhr = this as XMLHttpRequestPlus;
    if (!xhr.__headers) {
      xhr.__headers = {};
    }
    const token = storeService.getToken() ?? "";
    const tokenName = storeService.getTokenName() || "x-token-id";
    if (name === tokenName) {
      value = token;
    }
    xhr.__headers[name] = value;
    return setRequestHeader.call(this, name, value);
  };

  // 重写 send 方法，添加状态处理
  window.XMLHttpRequest.prototype.send = function (...rest) {
    const onreadystatechange = this.onreadystatechange;
    const onloadend = this.onloadend;
    const xhr = this as XMLHttpRequestPlus;

    // 重写 onreadystatechange 回调
    if (onreadystatechange) {
      this.onreadystatechange = function (ev) {
        const flag =
          this.status === 0 &&
          !(this.responseURL && this.responseURL.indexOf("file:") === 0);
        if (this.readyState === 4 && !flag) {
          setTimeout(() => {
            handleInterceptResponse.call(
              xhr,
              ev,
              onreadystatechange,
              "onreadystatechange",
              rest,
              onConfirm
            );
          });
        }
      };
    }

    // 重写 onloadend 回调
    if (onloadend) {
      this.onloadend = function (ev) {
        handleInterceptResponse.call(
          xhr,
          ev,
          onloadend,
          "onloadend",
          rest,
          onConfirm
        );
      };
    }

    // 调用原始 send 方法
    return originalSend.call(this, ...rest);
  };
}

// 启动拦截逻辑
setup({
  onConfirm: () =>
    new Promise((resolve, reject) => {
      loginModal(() => resolve(), reject);
    }),
  retryCount: 3,
  interceptStatusCodes: [401],
  whiteList: [
    { method: "post", url: "/szl-center-auth/logout" }, // 退出登录接口白名单
  ],
});
