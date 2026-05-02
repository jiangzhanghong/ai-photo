declare namespace WechatMiniprogram {
  interface BaseEvent {
    currentTarget: {
      dataset: Record<string, unknown>;
    };
    target?: {
      dataset?: Record<string, unknown>;
    };
  }

  interface TouchEvent extends BaseEvent {}

  interface Input extends BaseEvent {
    detail: {
      value: string | number;
    };
  }

  interface PickerChange extends BaseEvent {
    detail: {
      value: string | number;
    };
  }
}

declare const wx: any;

declare function Page(options: any): void;

declare function App<T = any>(options: T): void;

declare function getApp<T = any>(): T;
