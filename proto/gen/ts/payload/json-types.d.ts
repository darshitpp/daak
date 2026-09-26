export type AnyCborJSON =
  | {
      uint: number;
    }
  | {
      nint: number | string;
    }
  | {
      bytes: string;
    }
  | {
      text: string;
    }
  | {
      array: AnyCborJSON[];
    }
  | {
      map: [unknown, unknown][];
    }
  | {
      /**
       * @minItems 2
       * @maxItems 2
       */
      tag: [unknown, unknown];
    }
  | {
      bool: boolean;
    }
  | {
      null: null;
    }
  | {
      undefined: null;
    }
  | {
      unassigned: number;
    }
  | {
      float: number | string;
    };

export interface DeviceRefJSON {
  /**
   * @minItems 16
   * @maxItems 16
   */
  device_id: [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number
  ];
  name: string;
}
export interface ItemJSON {
  attrs?: {
    [k: string]: unknown;
  };
  children?: ItemJSON[] | null;
  chunk_count?: number | null;
  chunk_size?: number | null;
  /**
   * @minItems 32
   * @maxItems 32
   */
  hash?:
    | [
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number
      ]
    | null;
  index: number;
  item_type: string;
  mime?: string | null;
  name?: string | null;
  /**
   * @minItems 16
   * @maxItems 16
   */
  reply_to?:
    | [
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number
      ]
    | null;
  size?: number | null;
  text?: string | null;
}
export interface PayloadManifestJSON {
  created_at: number;
  extensions?: {
    [k: string]: unknown;
  };
  items: ItemJSON[];
  kind: string;
  meta?: {
    [k: string]: unknown;
  };
  /**
   * @minItems 16
   * @maxItems 16
   */
  payload_id: [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number
  ];
  /**
   * @minItems 16
   * @maxItems 16
   */
  reply_to?:
    | [
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number
      ]
    | null;
  sender: DeviceRefJSON;
  v: number;
}
