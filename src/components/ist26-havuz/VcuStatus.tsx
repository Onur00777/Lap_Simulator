import type { Ist26VcuState, VcuSafetyFsmRuntimeState } from '@/lib/ist26-havuz/vcu-fault-machine';

const STATE_LABELS: Record<Ist26VcuState, string> = {
  VCU_STATE_INIT: 'Başlatılıyor',
  VCU_STATE_PRECHARGE: 'Ön şarj',
  VCU_STATE_READY: 'Sürüş onayı bekleniyor',
  VCU_STATE_DRIVE: 'Sürüşe hazır',
  VCU_STATE_DERATE: 'Tork sınırlı',
  VCU_STATE_FAULT_LATCHED: 'Tork kesildi',
  VCU_STATE_FAULT_SAFE: 'Güvenli kesme',
};

export default function VcuStatus({ runtime }: { runtime: VcuSafetyFsmRuntimeState }) {
  const reason = runtime.bspdFaultSafeLatched ? 'BSPD devreye girdi. Devreyi yeniden kurmak için simülasyonu sıfırla.'
    : runtime.state === 'VCU_STATE_FAULT_SAFE' ? 'Sıcaklık sınırı aşıldı.'
    : runtime.state === 'VCU_STATE_FAULT_LATCHED' && runtime.appsImplausibilityLatched ? 'Gaz sensörleri uyuşmuyor. Gazı bırak ve sensör farkını düzelt.'
    : runtime.state === 'VCU_STATE_FAULT_LATCHED' ? 'Gaz ve fren birlikte etkin. Gazı bırak.'
    : runtime.state === 'VCU_STATE_DERATE' ? 'Sıcaklık veya IMU durumu torku sınırlıyor.'
    : null;
  return (
    <div className="rounded-xl border border-white/10 bg-[#0c1019] p-4">
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <div>
          <dt className="text-xs text-slate-400">SDC devresi</dt>
          <dd className={'mt-1 text-sm font-semibold ' + (runtime.sdcRelayClosed ? 'text-emerald-300' : 'text-rose-300')}>
            {runtime.sdcRelayClosed ? 'Kapalı' : 'Açık · kesildi'}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-slate-400">Tork komutu</dt>
          <dd className="mt-1 font-mono text-sm tabular-nums text-white">{runtime.cascadiaTorqueCmdNm.toFixed(1)} Nm</dd>
        </div>
        <div className="col-span-2 sm:col-span-1">
          <dt className="text-xs text-slate-400">VCU durumu</dt>
          <dd className="mt-1 text-sm text-white">{STATE_LABELS[runtime.state]}</dd>
        </div>
      </dl>
      {reason && <p className="mt-3 border-t border-white/10 pt-3 text-sm text-slate-300">{reason}</p>}
    </div>
  );
}
