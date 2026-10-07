export type DevicesRequestJSON = "ValueText44657669636573";
export type IpcEventJSON =
  | {
      DeviceFoundEvent: DeviceFoundEventJSON;
    }
  | {
      DeviceStateEvent: DeviceStateEventJSON;
    }
  | {
      PairingSasEvent: PairingSasEventJSON;
    }
  | {
      PairingDoneEvent: PairingDoneEventJSON;
    }
  | {
      TransferProgressEvent: TransferProgressEventJSON;
    }
  | {
      TransferItemEvent: TransferItemEventJSON;
    }
  | {
      TransferDoneEvent: TransferDoneEventJSON;
    }
  | {
      TransferFailedEvent: TransferFailedEventJSON;
    }
  | {
      InboxReceivedEvent: InboxReceivedEventJSON;
    }
  | {
      IncompatiblePeerEvent: IncompatiblePeerEventJSON;
    }
  | {
      QueueDepthEvent: QueueDepthEventJSON;
    };
export type IpcMessageJSON =
  | {
      RequestArm: RequestArmJSON;
    }
  | {
      ResponseArm: ResponseArmJSON;
    }
  | {
      EventArm: EventArmJSON;
    };
export type IpcRequestJSON =
  | {
      StartRequest: StartRequestJSON;
    }
  | {
      SubscribeRequest: SubscribeRequestJSON;
    }
  | {
      DevicesRequest: DevicesRequestJSON;
    }
  | {
      PairRequest: PairRequestJSON;
    }
  | {
      SendRequest: SendRequestJSON;
    }
  | {
      CancelRequest: CancelRequestJSON;
    }
  | {
      RetryRequest: RetryRequestJSON;
    }
  | {
      RetryItemRequest: RetryItemRequestJSON;
    }
  | {
      QuarantineReportRequest: QuarantineReportRequestJSON;
    }
  | {
      ListQuarantineReportsRequest: ListQuarantineReportsRequestJSON;
    }
  | {
      DeleteQuarantinedRequest: DeleteQuarantinedRequestJSON;
    }
  | {
      ListTransfersRequest: ListTransfersArgsJSON;
    }
  | {
      ListInboxRequest: ListInboxRequestJSON;
    }
  | {
      SelfProfileRequest: SelfProfileRequestJSON;
    }
  | {
      SetDisplayNameRequest: SetDisplayNameRequestJSON;
    }
  | {
      SetPresenceRequest: SetPresenceRequestJSON;
    }
  | {
      ExportDebugBundleRequest: ExportDebugBundleRequestJSON;
    }
  | {
      ShutdownRequest: ShutdownRequestJSON;
    }
  | {
      WakeRequest: WakeRequestJSON;
    }
  | {
      RevokeRequest: RevokeRequestJSON;
    };
export type SubscribeRequestJSON = "ValueText537562736372696265";
export type ListQuarantineReportsRequestJSON = "ValueText4C69737451756172616E74696E655265706F727473";
export type ListInboxRequestJSON = "ValueText4C697374496E626F78";
export type SelfProfileRequestJSON = "ValueText53656C6650726F66696C65";
export type ShutdownRequestJSON = "ValueText53687574646F776E";
export type WakeRequestJSON = "ValueText57616B65";
export type IpcResponseJSON =
  | {
      OkResponse: OkResponseJSON;
    }
  | {
      ErrorResponse: ErrorResponseJSON;
    }
  | {
      JsonResponse: JsonResponseJSON;
    }
  | {
      PortResponse: PortResponseJSON;
    }
  | {
      UpdateRequiredResponse: UpdateRequiredResponseJSON;
    };
export type OkResponseJSON = "ValueText4F6B";

export interface CancelRequestJSON {
  cancel: TransferRefJSON;
}
export interface TransferRefJSON {
  transfer_id: string;
}
export interface DeleteQuarantinedRequestJSON {
  delete_quarantined: ItemRefJSON;
}
export interface ItemRefJSON {
  item_index: number;
  transfer_id: string;
}
export interface DeviceFoundArgsJSON {
  addr: string;
  device_id: string;
  name: string;
}
export interface DeviceFoundEventJSON {
  device_found: DeviceFoundArgsJSON;
}
export interface DeviceStateArgsJSON {
  device_id: string;
  online: boolean;
}
export interface DeviceStateEventJSON {
  device_state: DeviceStateArgsJSON;
}
export interface DisplayNameArgsJSON {
  name: string;
}
export interface ErrorArgsJSON {
  message: string;
}
export interface ErrorResponseJSON {
  error: ErrorArgsJSON;
}
export interface EventArmJSON {
  event: IpcEventJSON;
}
export interface PairingSasEventJSON {
  pairing_sas: PairingSasArgsJSON;
}
export interface PairingSasArgsJSON {
  peer_device_id: string;
  sas: string;
}
export interface PairingDoneEventJSON {
  pairing_done: PairingDoneArgsJSON;
}
export interface PairingDoneArgsJSON {
  device_id: string;
}
export interface TransferProgressEventJSON {
  transfer_progress: TransferProgressArgsJSON;
}
export interface TransferProgressArgsJSON {
  bytes_done: number;
  bytes_total: number;
  transfer_id: string;
}
export interface TransferItemEventJSON {
  transfer_item: TransferItemArgsJSON;
}
export interface TransferItemArgsJSON {
  dest_path: string;
  item_index: number;
  state: string;
  transfer_id: string;
}
export interface TransferDoneEventJSON {
  transfer_done: TransferRefJSON;
}
export interface TransferFailedEventJSON {
  transfer_failed: TransferFailedArgsJSON;
}
export interface TransferFailedArgsJSON {
  error: string;
  transfer_id: string;
}
export interface InboxReceivedEventJSON {
  inbox_received: InboxReceivedArgsJSON;
}
export interface InboxReceivedArgsJSON {
  payload_json: string;
}
export interface IncompatiblePeerEventJSON {
  incompatible_peer: IncompatiblePeerArgsJSON;
}
export interface IncompatiblePeerArgsJSON {
  our_version: number;
  peer_device_id: string;
  peer_name: string;
  peer_version: number;
}
export interface QueueDepthEventJSON {
  queue_depth: QueueDepthArgsJSON;
}
export interface QueueDepthArgsJSON {
  device_id: string;
  queued: number;
}
export interface ExportDebugBundleArgsJSON {
  path: string;
}
export interface ExportDebugBundleRequestJSON {
  export_debug_bundle: ExportDebugBundleArgsJSON;
}
export interface IpcFrameJSON {
  msg: IpcMessageJSON;
  v: number;
}
export interface RequestArmJSON {
  request: IpcRequestJSON;
}
export interface StartRequestJSON {
  start: StartArgsJSON;
}
export interface StartArgsJSON {
  data_dir: string;
  display_name: string;
  listen_port: number;
}
export interface PairRequestJSON {
  pair: PairArgsJSON;
}
export interface PairArgsJSON {
  addr: string;
  bundle_cbor: number[];
}
export interface SendRequestJSON {
  send: SendArgsJSON;
}
export interface SendArgsJSON {
  files: string[];
  peer_device_id: string;
  text?: string | null;
}
export interface RetryRequestJSON {
  retry: TransferRefJSON;
}
export interface RetryItemRequestJSON {
  retry_item: RetryItemArgsJSON;
}
export interface RetryItemArgsJSON {
  item_index: number;
  transfer_id: string;
}
export interface QuarantineReportRequestJSON {
  quarantine_report: ItemRefJSON;
}
export interface ListTransfersArgsJSON {
  filter?: TransferFilterJSON | null;
}
export interface TransferFilterJSON {
  peer_device_id?: string | null;
  state?: string | null;
}
export interface SetDisplayNameRequestJSON {
  set_display_name: DisplayNameArgsJSON;
}
export interface SetPresenceRequestJSON {
  set_presence: SetPresenceArgsJSON;
}
export interface SetPresenceArgsJSON {
  state: string;
}
export interface RevokeRequestJSON {
  revoke: RevokeArgsJSON;
}
export interface RevokeArgsJSON {
  peer_device_id: string;
}
export interface ResponseArmJSON {
  response: IpcResponseJSON;
}
export interface JsonResponseJSON {
  json: JsonArgsJSON;
}
export interface JsonArgsJSON {
  value: string;
}
export interface PortResponseJSON {
  port: PortArgsJSON;
}
export interface PortArgsJSON {
  port: number;
}
export interface UpdateRequiredResponseJSON {
  update_required: UpdateRequiredArgsJSON;
}
export interface UpdateRequiredArgsJSON {
  min_major: number;
}
