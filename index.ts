import storeService from "@/service/storage";

const originalSend = window.XMLHttpRequest.prototype.send;
const originalOpen = window.XMLHttpRequest.prototype.open;
const setRequestHeader = window.XMLHttpRequest.prototype.setRequestHeader;

interface OpenParams {
  method: string;
  url: string | URL;
  async?: boolean;
  username?: string | null;
  password?: string | null;
}

interface XMLHttpRequestPlus extends XMLHttpRequest {
  openParams: OpenParams;
  retryCount: number;
  __headers: Record<string, string>;
}

interface WhiteList {
  method: string;
  url: string | URL;
}

interface Config {
  /** 登录弹框函数，返回一个 Promise */
  loginModal: () => Promise<boolean>;
  /** 最大重试次数 */
  retryCount: number;
  /** 拦截的 HTTP 状态码 */
  interceptStatusCode: number;
  /** 白名单 */
  whiteList: WhiteList[];
}

// 默认配置
const defaultConfig: Config = {
  loginModal: () => Promise.resolve(true), // 默认的登录弹框逻辑
  retryCount: 3, // 默认最大重试次数
  interceptStatusCode: 401, // 默认拦截 401 状态码
  whiteList: [], // 默认没有白名单
};

// 保存运行时的配置
let runtimeConfig: Config = { ...defaultConfig };

const pendingAuthPromises: Promise<boolean>[] = [];
let loginPromise: Promise<boolean> | null = null;

/**
 * 判断是否在白名单中
 */
function isInWhiteList(method: string, url: string | URL): boolean {
  return runtimeConfig.whiteList.some(
    (item) => item.method === method.toLowerCase() && item.url === url
  );
}

/**
 * 处理拦截的 HTTP 状态码响应
 */
function handleInterceptResponse(
  this: XMLHttpRequestPlus,
  rest: (Document | XMLHttpRequestBodyInit | null | undefined)[],
  funName: "onloadend" | "onreadystatechange",
  fun: any
) {
  // 初始化登录弹框 Promise
  if (!loginPromise) {
    loginPromise = runtimeConfig.loginModal().then(() => {
      loginPromise = null;
      pendingAuthPromises.length = 0;
      return true;
    });
  }

  // 创建重试逻辑的 Promise
  const retryPromise = new Promise<boolean>((resolve) => {
    loginPromise?.then(() => {
      const params = this.openParams;

      // 重新初始化请求
      this.open(
        params.method,
        params.url,
        !!params.async,
        params.username,
        params.password
      );

      const token = storeService.getToken() ?? "";
      const tokenName = storeService.getTokenName() || "x-token-id";

      // 恢复请求头
      Object.entries(this.__headers).forEach(([key, value]) => {
        this.setRequestHeader(key, key === tokenName ? token : value);
      });

      // 检查是否超过最大重试次数
      if ((this.retryCount || 0) < runtimeConfig.retryCount) {
        this.retryCount = (this.retryCount || 0) + 1;
        this.send(...rest);

        // 更新回调处理
        this[funName] = function (ev) {
          fun?.call(this, ev);
          resolve(true);
        };
      } else {
        resolve(false); // 达到最大重试次数，终止
      }
    });
  });

  pendingAuthPromises.push(retryPromise);
}

/**
 * 通用响应处理
 */
function handleResponse(
  this: XMLHttpRequestPlus,
  ev: ProgressEvent | Event,
  fun: any,
  funName: "onloadend" | "onreadystatechange",
  rest: (Document | XMLHttpRequestBodyInit | null | undefined)[]
) {
  const isJsonResponse =
    this.getResponseHeader("content-type")?.split(";")[0] ===
    "application/json";

  const openParams = this.openParams;
  const isWhiteList = isInWhiteList(openParams.method, openParams.url);

  if (isWhiteList) {
    loginPromise = null;
    pendingAuthPromises.length = 0;
  }

  if (isJsonResponse && !isWhiteList) {
    try {
      const response = JSON.parse(this.responseText);
      if (Number(response.code) === runtimeConfig.interceptStatusCode) {
        handleInterceptResponse.call(this, rest, funName, fun);
        return;
      }
    } catch (error) {
      console.log(error);
    }
  }

  fun?.call(this, ev);
}

/**
 * 启动拦截逻辑
 * @param config 用户自定义配置
 */
function setup(config: Partial<Config> = {}) {
  runtimeConfig = { ...defaultConfig, ...config }; // 合并默认配置和用户配置

  // 重写 open 方法
  window.XMLHttpRequest.prototype.open = function (
    method,
    url,
    async?: boolean,
    username?: string | null,
    password?: string | null
  ) {
    (this as XMLHttpRequestPlus).openParams = {
      method,
      url,
      async,
      username,
      password,
    };
    return originalOpen.call(this, method, url, async!, username, password);
  };

  // 重写 setRequestHeader 方法
  window.XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    if (!(this as XMLHttpRequestPlus).__headers) {
      (this as XMLHttpRequestPlus).__headers = {};
    }
    const token = storeService.getToken() ?? "";
    const tokenName = storeService.getTokenName() || "x-token-id";
    if (name === tokenName) {
      value = token;
    }
    (this as XMLHttpRequestPlus).__headers[name] = value;
    return setRequestHeader.call(this, name, value);
  };

  // 重写 send 方法
  window.XMLHttpRequest.prototype.send = function (...rest) {
    const onreadystatechange = this.onreadystatechange;
    const onloadend = this.onloadend;
    const xhr = this as XMLHttpRequestPlus;

    if (onreadystatechange) {
      this.onreadystatechange = function (ev) {
        if (this.readyState === 4) {
          setTimeout(() => {
            handleResponse.call(
              xhr,
              ev,
              onreadystatechange,
              "onreadystatechange",
              rest
            );
          });
        }
      };
    }

    if (onloadend) {
      this.onloadend = function (ev) {
        handleResponse.call(xhr, ev, onloadend, "onloadend", rest);
      };
    }

    return originalSend.call(this, ...rest);
  };
}

export default setup;
