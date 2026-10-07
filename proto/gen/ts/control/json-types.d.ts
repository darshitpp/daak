export interface AckJSON {
  complete: boolean;
  hash_ok: boolean;
  item_index: number;
  /**
   * @minItems 16
   * @maxItems 16
   */
  transfer_id: [
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
}
export interface BeaconJSON {
  body: number[];
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
  seq: number;
  /**
   * @minItems 16
   * @maxItems 16
   */
  session_id: [
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
  v: number;
}
export interface HelloJSON {
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
}
export interface NackJSON {
  item_index: number;
  ranges: RangeJSON[];
  /**
   * @minItems 16
   * @maxItems 16
   */
  transfer_id: [
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
}
export interface RangeJSON {
  index_0: number;
  index_1: number;
}
