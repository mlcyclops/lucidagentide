// OTLP/HTTP protobuf bodies (API contract 11.1 kind `otlp`), hand-encoded from the opentelemetry-proto v1 field numbers
// (no protobuf crate): `ExportMetricsServiceRequest`, `ExportLogsServiceRequest`, `ExportTraceServiceRequest`. Fields are
// written in field-number order; non-oneof scalars at their default (0, empty) are omitted as proto3 does, oneof members
// (AnyValue, NumberDataPoint.as_double) are always written. Input records are the shapes `api_export_wire` documents:
// already transformed by the engine.
//
// Field numbers used (opentelemetry/proto/...):
//   common/v1: AnyValue { string_value 1, bool_value 2, int_value 3, double_value 4, array_value 5, kvlist_value 6 }
//              ArrayValue { values 1 }  KeyValueList { values 1 }  KeyValue { key 1, value 2 }
//              InstrumentationScope { name 1, version 2 }
//   resource/v1: Resource { attributes 1 }
//   collector/*: Export{Metrics,Logs,Trace}ServiceRequest { resource_{metrics,logs,spans} 1 }
//   metrics/v1: ResourceMetrics { resource 1, scope_metrics 2 }  ScopeMetrics { scope 1, metrics 2 }
//               Metric { name 1, description 2, unit 3, gauge 5, sum 7 }  Gauge { data_points 1 }
//               Sum { data_points 1, aggregation_temporality 2 (DELTA 1, CUMULATIVE 2), is_monotonic 3 }
//               NumberDataPoint { start_time_unix_nano 2 (fixed64), time_unix_nano 3 (fixed64), as_double 4, attributes 7 }
//   logs/v1: ResourceLogs { resource 1, scope_logs 2 }  ScopeLogs { scope 1, log_records 2 }
//            LogRecord { time_unix_nano 1 (fixed64), severity_number 2, body 5, attributes 6, event_name 12 }
//   trace/v1: ResourceSpans { resource 1, scope_spans 2 }  ScopeSpans { scope 1, spans 2 }
//             Span { trace_id 1, span_id 2, parent_span_id 4, name 5, kind 6, start_time_unix_nano 7 (fixed64),
//                    end_time_unix_nano 8 (fixed64), attributes 9, status 15 }  Status { message 2, code 3 (OK 1, ERROR 2) }

use serde_json::{Map, Value};

const VARINT: u8 = 0;
const I64: u8 = 1;
const LEN: u8 = 2;

/// The scope name on every exported metric, log and span.
pub const SCOPE: &str = "lucid";

/// A protobuf writer: nested messages are written in place and their length prefix spliced in after.
#[derive(Default)]
pub struct Pb {
    pub buf: Vec<u8>,
}

impl Pb {
    fn varint(&mut self, mut v: u64) {
        while v >= 0x80 {
            self.buf.push((v as u8) | 0x80);
            v >>= 7;
        }
        self.buf.push(v as u8);
    }

    fn key(&mut self, field: u32, wire: u8) {
        self.varint(((field as u64) << 3) | wire as u64);
    }

    /// A varint field, omitted at 0.
    fn uint(&mut self, field: u32, v: u64) {
        if v != 0 {
            self.key(field, VARINT);
            self.varint(v);
        }
    }

    /// An int64 oneof member: always written, negative values as ten-byte two's complement.
    fn int_always(&mut self, field: u32, v: i64) {
        self.key(field, VARINT);
        self.varint(v as u64);
    }

    fn bool_always(&mut self, field: u32, v: bool) {
        self.key(field, VARINT);
        self.varint(v as u64);
    }

    /// A fixed64 field, omitted at 0.
    fn fixed64(&mut self, field: u32, v: u64) {
        if v != 0 {
            self.key(field, I64);
            self.buf.extend_from_slice(&v.to_le_bytes());
        }
    }

    fn double_always(&mut self, field: u32, v: f64) {
        self.key(field, I64);
        self.buf.extend_from_slice(&v.to_bits().to_le_bytes());
    }

    fn bytes_always(&mut self, field: u32, v: &[u8]) {
        self.key(field, LEN);
        self.varint(v.len() as u64);
        self.buf.extend_from_slice(v);
    }

    /// A string or bytes field, omitted when empty.
    fn bytes(&mut self, field: u32, v: &[u8]) {
        if !v.is_empty() {
            self.bytes_always(field, v);
        }
    }

    fn str(&mut self, field: u32, v: &str) {
        self.bytes(field, v.as_bytes());
    }

    /// An embedded message, always written (an empty one too).
    fn msg(&mut self, field: u32, body: impl FnOnce(&mut Pb)) {
        self.key(field, LEN);
        let start = self.buf.len();
        body(self);
        let mut n = (self.buf.len() - start) as u64;
        let mut prefix = [0u8; 10];
        let mut k = 0;
        while n >= 0x80 {
            prefix[k] = (n as u8) | 0x80;
            n >>= 7;
            k += 1;
        }
        prefix[k] = n as u8;
        self.buf.splice(start..start, prefix[..=k].iter().copied());
    }
}

/// AnyValue from JSON: string, bool, int (integers that fit i64), double, array, kvlist; null is an empty AnyValue.
fn any_value(pb: &mut Pb, v: &Value) {
    match v {
        Value::String(s) => pb.bytes_always(1, s.as_bytes()),
        Value::Bool(b) => pb.bool_always(2, *b),
        Value::Number(n) => match n.as_i64() {
            Some(i) => pb.int_always(3, i),
            None => pb.double_always(4, n.as_f64().unwrap_or(0.0)),
        },
        Value::Array(a) => pb.msg(5, |pb| {
            for x in a {
                pb.msg(1, |pb| any_value(pb, x));
            }
        }),
        Value::Object(o) => pb.msg(6, |pb| {
            for (k, x) in o {
                pb.msg(1, |pb| key_value(pb, k, x));
            }
        }),
        Value::Null => {}
    }
}

/// KeyValue { key 1, value 2 }.
fn key_value(pb: &mut Pb, k: &str, v: &Value) {
    pb.bytes_always(1, k.as_bytes());
    pb.msg(2, |pb| any_value(pb, v));
}

/// Repeated KeyValue attributes of a JSON object (absent or non-object: none).
fn attributes(pb: &mut Pb, field: u32, attrs: Option<&Value>) {
    if let Some(Value::Object(o)) = attrs {
        for (k, v) in o {
            pb.msg(field, |pb| key_value(pb, k, v));
        }
    }
}

/// Resource { attributes 1 } with string values (contract 10.2).
fn resource(pb: &mut Pb, attrs: &[(String, String)]) {
    for (k, v) in attrs {
        pb.msg(1, |pb| {
            pb.bytes_always(1, k.as_bytes());
            pb.msg(2, |pb| pb.bytes_always(1, v.as_bytes()));
        });
    }
}

/// InstrumentationScope { name 1, version 2 }.
fn scope(pb: &mut Pb, version: &str) {
    pb.str(1, SCOPE);
    pb.str(2, version);
}

fn ns(ms: i64) -> u64 {
    (ms.max(0) as u64).saturating_mul(1_000_000)
}

fn ms_of(o: &Map<String, Value>, k: &str) -> Result<i64, String> {
    o.get(k).and_then(Value::as_i64).ok_or_else(|| format!("a record lacks its integer {k}"))
}

fn obj(v: &Value) -> Result<&Map<String, Value>, String> {
    v.as_object().ok_or_else(|| "a record is not a JSON object".to_string())
}

/// One Metric from `{"name", "description"?, "kind": "gauge"|"sum", "unit", "temporality", "points": [{"t_ms",
/// "start_ms"?, "v", "labels"}]}`. Sums are monotonic (the catalog's counters).
pub fn metric(pb: &mut Pb, rec: &Value) -> Result<(), String> {
    let o = obj(rec)?;
    let name = o.get("name").and_then(Value::as_str).filter(|s| !s.is_empty()).ok_or("a metric record lacks its name")?;
    let points = o.get("points").and_then(Value::as_array).ok_or("a metric record lacks its points")?;
    let mut checked = Vec::with_capacity(points.len());
    for p in points {
        let p = obj(p)?;
        let t = ms_of(p, "t_ms")?;
        let start = p.get("start_ms").and_then(Value::as_i64).unwrap_or(0);
        let v = p.get("v").and_then(Value::as_f64).ok_or("a metric point lacks its value")?;
        checked.push((start, t, v, p.get("labels")));
    }
    let data_points = |pb: &mut Pb| {
        for (start, t, v, labels) in &checked {
            pb.msg(1, |pb| {
                pb.fixed64(2, ns(*start));
                pb.fixed64(3, ns(*t));
                pb.double_always(4, *v);
                attributes(pb, 7, *labels);
            });
        }
    };
    pb.str(1, name);
    pb.str(2, o.get("description").and_then(Value::as_str).unwrap_or_default());
    pb.str(3, o.get("unit").and_then(Value::as_str).unwrap_or_default());
    match o.get("kind").and_then(Value::as_str) {
        Some("gauge") => pb.msg(5, data_points),
        Some("sum") => {
            let temporality = match o.get("temporality").and_then(Value::as_str) {
                Some("delta") => 1,
                Some("cumulative") | None => 2,
                Some(other) => return Err(format!("a metric record has the unknown temporality {other}")),
            };
            pb.msg(7, |pb| {
                data_points(pb);
                pb.uint(2, temporality);
                pb.bool_always(3, true);
            });
        }
        _ => return Err(format!("the metric {name} is neither a gauge nor a sum")),
    }
    Ok(())
}

/// One LogRecord from `{"t_ms", "severity", "event", "body", "attributes"}`; the body is an AnyValue (kvlist for an
/// object, string for text).
pub fn log_record(pb: &mut Pb, rec: &Value) -> Result<(), String> {
    let o = obj(rec)?;
    let t = ms_of(o, "t_ms")?;
    let sev = o.get("severity").and_then(Value::as_u64).filter(|s| *s <= 24).ok_or("a log record lacks a severity number 0 to 24")?;
    pb.fixed64(1, ns(t));
    pb.uint(2, sev);
    if let Some(body) = o.get("body").filter(|b| !b.is_null()) {
        pb.msg(5, |pb| any_value(pb, body));
    }
    attributes(pb, 6, o.get("attributes"));
    pb.str(12, o.get("event").and_then(Value::as_str).unwrap_or_default());
    Ok(())
}

fn hex_id(o: &Map<String, Value>, k: &str, n: usize) -> Result<Option<Vec<u8>>, String> {
    let Some(s) = o.get(k).and_then(Value::as_str) else { return Ok(None) };
    let b = s.as_bytes();
    if b.len() != 2 * n || !b.iter().all(u8::is_ascii_hexdigit) {
        return Err(format!("a span's {k} is not {} hex digits", 2 * n));
    }
    let d = |c: u8| (c as char).to_digit(16).unwrap_or(0) as u8;
    Ok(Some(b.chunks(2).map(|p| d(p[0]) << 4 | d(p[1])).collect()))
}

/// One Span from `{"trace_id", "span_id", "parent_span_id"?, "name", "kind"?, "start_ms", "end_ms", "status",
/// "status_message"?, "attributes"}`.
pub fn span(pb: &mut Pb, rec: &Value) -> Result<(), String> {
    let o = obj(rec)?;
    let trace = hex_id(o, "trace_id", 16)?.ok_or("a span lacks its trace_id")?;
    let id = hex_id(o, "span_id", 8)?.ok_or("a span lacks its span_id")?;
    let parent = hex_id(o, "parent_span_id", 8)?;
    let name = o.get("name").and_then(Value::as_str).filter(|s| !s.is_empty()).ok_or("a span lacks its name")?;
    let kind = match o.get("kind").and_then(Value::as_str) {
        None => 0,
        Some("internal") => 1,
        Some("server") => 2,
        Some("client") => 3,
        Some(other) => return Err(format!("a span has the unknown kind {other}")),
    };
    let start = ms_of(o, "start_ms")?;
    let end = ms_of(o, "end_ms")?;
    let code = match o.get("status").and_then(Value::as_str) {
        None | Some("unset") => 0,
        Some("ok") => 1,
        Some("error") => 2,
        Some(other) => return Err(format!("a span has the unknown status {other}")),
    };
    pb.bytes(1, &trace);
    pb.bytes(2, &id);
    if let Some(p) = &parent {
        pb.bytes(4, p);
    }
    pb.str(5, name);
    pb.uint(6, kind);
    pb.fixed64(7, ns(start));
    pb.fixed64(8, ns(end));
    attributes(pb, 9, o.get("attributes"));
    let message = o.get("status_message").and_then(Value::as_str).unwrap_or_default();
    if code != 0 || !message.is_empty() {
        pb.msg(15, |pb| {
            pb.str(2, message);
            pb.uint(3, code);
        });
    }
    Ok(())
}

/// Request { 1: Resource<Signal> { 1: Resource, 2: Scope<Signal> { 1: scope, 2: item* } } }: the three requests share
/// this nesting and these field numbers.
fn request(resource_attrs: &[(String, String)], version: &str, records: &[Value], item: fn(&mut Pb, &Value) -> Result<(), String>) -> Result<Vec<u8>, String> {
    let mut pb = Pb { buf: Vec::with_capacity(256 + records.len() * 128) };
    let mut err = None;
    pb.msg(1, |pb| {
        pb.msg(1, |pb| resource(pb, resource_attrs));
        pb.msg(2, |pb| {
            pb.msg(1, |pb| scope(pb, version));
            for r in records {
                pb.msg(2, |pb| {
                    if let Err(e) = item(pb, r) {
                        err.get_or_insert(e);
                    }
                });
            }
        });
    });
    match err {
        Some(e) => Err(e),
        None => Ok(pb.buf),
    }
}

/// `ExportMetricsServiceRequest` for one resource.
pub fn metrics_request(resource_attrs: &[(String, String)], version: &str, records: &[Value]) -> Result<Vec<u8>, String> {
    request(resource_attrs, version, records, metric)
}

/// `ExportLogsServiceRequest` for one resource (logs and audit records).
pub fn logs_request(resource_attrs: &[(String, String)], version: &str, records: &[Value]) -> Result<Vec<u8>, String> {
    request(resource_attrs, version, records, log_record)
}

/// `ExportTraceServiceRequest` for one resource.
pub fn traces_request(resource_attrs: &[(String, String)], version: &str, records: &[Value]) -> Result<Vec<u8>, String> {
    request(resource_attrs, version, records, span)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn cat(parts: &[&[u8]]) -> Vec<u8> {
        parts.concat()
    }

    fn any(v: &Value) -> Vec<u8> {
        let mut pb = Pb::default();
        any_value(&mut pb, v);
        pb.buf
    }

    #[test]
    fn otlp_any_value_bytes() {
        // string_value 1: tag 0x0a, length 1, "a"
        assert_eq!(any(&json!("a")), [0x0a, 0x01, b'a']);
        // bool_value 2: tag 0x10
        assert_eq!(any(&json!(true)), [0x10, 0x01]);
        // int_value 3: tag 0x18; -1 is ten bytes of two's complement
        assert_eq!(any(&json!(-1)), [0x18, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01]);
        assert_eq!(any(&json!(300)), [0x18, 0xac, 0x02]);
        // double_value 4: tag 0x21, 1.5 = 0x3ff8000000000000 little-endian
        assert_eq!(any(&json!(1.5)), [0x21, 0, 0, 0, 0, 0, 0, 0xf8, 0x3f]);
        // array_value 5 (tag 0x2a) of ArrayValue { values 1 (tag 0x0a) }
        assert_eq!(any(&json!(["x"])), [0x2a, 0x05, 0x0a, 0x03, 0x0a, 0x01, b'x']);
        // kvlist_value 6 (tag 0x32) of KeyValueList { values 1 } of KeyValue { key 1 (0x0a), value 2 (0x12) }
        assert_eq!(any(&json!({"k": "v"})), [0x32, 0x0a, 0x0a, 0x08, 0x0a, 0x01, b'k', 0x12, 0x03, 0x0a, 0x01, b'v']);
        // null: an empty AnyValue
        assert!(any(&Value::Null).is_empty());
    }

    #[test]
    fn otlp_long_length_prefix_is_spliced() {
        let s = "x".repeat(200);
        // length 200 = varint 0xc8 0x01
        let b = any(&json!(s));
        assert_eq!(&b[..3], &[0x0a, 0xc8, 0x01]);
        assert_eq!(b.len(), 203);
        let b = any(&json!([s]));
        // inner AnyValue 203 bytes = 0xcb 0x01; outer ArrayValue 1 + 2 + 203 = 206 = 0xce 0x01
        assert_eq!(&b[..6], &[0x2a, 0xce, 0x01, 0x0a, 0xcb, 0x01]);
    }

    #[test]
    fn otlp_metrics_request_gauge_bytes() {
        let res = vec![("service.name".to_string(), "x".to_string())];
        let recs = [json!({"name": "m", "kind": "gauge", "unit": "1", "temporality": "cumulative", "points": [{"t_ms": 1, "v": 1.5, "labels": {}}]})];
        let got = metrics_request(&res, "1", &recs).unwrap();
        // KeyValue { key "service.name", value AnyValue { string "x" } } = 19 bytes
        let kv: &[u8] = &cat(&[&[0x0a, 0x0c], b"service.name", &[0x12, 0x03, 0x0a, 0x01, b'x']]);
        assert_eq!(kv.len(), 19);
        // Resource { attributes 1 } = 21 bytes
        let resource = cat(&[&[0x0a, 19], kv]);
        // InstrumentationScope { name 1 "lucid", version 2 "1" } = 10 bytes
        let scope = cat(&[&[0x0a, 0x05], b"lucid", &[0x12, 0x01, b'1']]);
        // NumberDataPoint { time_unix_nano 3 (tag 0x19) = 1_000_000, as_double 4 (tag 0x21) = 1.5 } = 18 bytes
        let dp = cat(&[&[0x19, 0x40, 0x42, 0x0f, 0, 0, 0, 0, 0], &[0x21, 0, 0, 0, 0, 0, 0, 0xf8, 0x3f]]);
        // Gauge { data_points 1 } = 20 bytes
        let gauge = cat(&[&[0x0a, 18], &dp]);
        // Metric { name 1 "m", unit 3 (tag 0x1a) "1", gauge 5 (tag 0x2a) } = 28 bytes
        let metric = cat(&[&[0x0a, 0x01, b'm', 0x1a, 0x01, b'1', 0x2a, 20], &gauge]);
        assert_eq!(metric.len(), 28);
        // ScopeMetrics { scope 1, metrics 2 } = 42 bytes
        let sm = cat(&[&[0x0a, 10], &scope, &[0x12, 28], &metric]);
        // ResourceMetrics { resource 1, scope_metrics 2 } = 67 bytes
        let rm = cat(&[&[0x0a, 21], &resource, &[0x12, 42], &sm]);
        assert_eq!(rm.len(), 67);
        // ExportMetricsServiceRequest { resource_metrics 1 }
        assert_eq!(got, cat(&[&[0x0a, 67], &rm]));
    }

    #[test]
    fn otlp_sum_metric_bytes() {
        let rec = json!({"name": "c", "kind": "sum", "unit": "By", "temporality": "delta", "points": [{"t_ms": 2, "start_ms": 1, "v": 3.0, "labels": {"a": "b"}}]});
        let mut pb = Pb::default();
        metric(&mut pb, &rec).unwrap();
        // NumberDataPoint { start 2 (0x11) 1 ms, time 3 (0x19) 2 ms, as_double 4 (0x21) 3.0, attributes 7 (0x3a) a=b } = 37
        let dp = cat(&[
            &[0x11, 0x40, 0x42, 0x0f, 0, 0, 0, 0, 0],
            &[0x19, 0x80, 0x84, 0x1e, 0, 0, 0, 0, 0],
            &[0x21, 0, 0, 0, 0, 0, 0, 0x08, 0x40],
            &[0x3a, 0x08, 0x0a, 0x01, b'a', 0x12, 0x03, 0x0a, 0x01, b'b'],
        ]);
        assert_eq!(dp.len(), 37);
        // Sum { data_points 1, aggregation_temporality 2 = DELTA (0x10 0x01), is_monotonic 3 (0x18 0x01) } = 43
        let sum = cat(&[&[0x0a, 37], &dp, &[0x10, 0x01, 0x18, 0x01]]);
        // Metric { name 1 "c", unit 3 "By", sum 7 (tag 0x3a) }
        let want = cat(&[&[0x0a, 0x01, b'c', 0x1a, 0x02, b'B', b'y', 0x3a, 43], &sum]);
        assert_eq!(pb.buf, want);
        let mut pb = Pb::default();
        let cumulative = json!({"name": "c", "kind": "sum", "unit": "", "temporality": "cumulative", "points": []});
        metric(&mut pb, &cumulative).unwrap();
        // empty unit omitted; Sum { aggregation_temporality 2 = CUMULATIVE, is_monotonic }
        assert_eq!(pb.buf, [0x0a, 0x01, b'c', 0x3a, 0x04, 0x10, 0x02, 0x18, 0x01]);
    }

    #[test]
    fn otlp_log_record_bytes() {
        let rec = json!({"t_ms": 1, "severity": 9, "event": "e", "body": {"k": 1}, "attributes": {"lucid.seq": 7}});
        let mut pb = Pb::default();
        log_record(&mut pb, &rec).unwrap();
        let want = cat(&[
            // time_unix_nano 1 (fixed64, tag 0x09) = 1_000_000
            &[0x09, 0x40, 0x42, 0x0f, 0, 0, 0, 0, 0],
            // severity_number 2 (tag 0x10) = 9
            &[0x10, 0x09],
            // body 5 (tag 0x2a): AnyValue { kvlist 6 (0x32): KeyValueList { KeyValue { "k", AnyValue { int 1 } } } }
            &[0x2a, 0x0b, 0x32, 0x09, 0x0a, 0x07, 0x0a, 0x01, b'k', 0x12, 0x02, 0x18, 0x01],
            // attributes 6 (tag 0x32): KeyValue { "lucid.seq", AnyValue { int 7 } }
            &[0x32, 0x0f, 0x0a, 0x09],
            b"lucid.seq",
            &[0x12, 0x02, 0x18, 0x07],
            // event_name 12 (tag 0x62) "e"
            &[0x62, 0x01, b'e'],
        ]);
        assert_eq!(pb.buf, want);
        // a string body is an AnyValue string
        let mut pb = Pb::default();
        log_record(&mut pb, &json!({"t_ms": 0, "severity": 0, "body": "hi"})).unwrap();
        assert_eq!(pb.buf, [0x2a, 0x04, 0x0a, 0x02, b'h', b'i']);
    }

    #[test]
    fn otlp_span_bytes() {
        let rec = json!({"trace_id": "0102030405060708090a0b0c0d0e0f10", "span_id": "a1a2a3a4a5a6a7a8", "name": "s", "start_ms": 1, "end_ms": 2, "status": "error", "attributes": {}});
        let mut pb = Pb::default();
        span(&mut pb, &rec).unwrap();
        let want = cat(&[
            // trace_id 1 (0x0a), 16 bytes
            &[0x0a, 0x10, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16],
            // span_id 2 (0x12), 8 bytes
            &[0x12, 0x08, 0xa1, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8],
            // name 5 (0x2a)
            &[0x2a, 0x01, b's'],
            // start 7 (fixed64, 0x39), end 8 (fixed64, 0x41)
            &[0x39, 0x40, 0x42, 0x0f, 0, 0, 0, 0, 0],
            &[0x41, 0x80, 0x84, 0x1e, 0, 0, 0, 0, 0],
            // status 15 (0x7a): Status { code 3 (0x18) = ERROR 2 }
            &[0x7a, 0x02, 0x18, 0x02],
        ]);
        assert_eq!(pb.buf, want);
        assert!(span(&mut Pb::default(), &json!({"trace_id": "01", "span_id": "a1a2a3a4a5a6a7a8", "name": "s", "start_ms": 1, "end_ms": 2})).is_err());
    }

    #[test]
    fn otlp_logs_and_traces_requests_nest_like_metrics() {
        let res = vec![("k".to_string(), "v".to_string())];
        let rec = json!({"t_ms": 0, "severity": 0});
        let got = logs_request(&res, "", &[rec]).unwrap();
        // ResourceLogs { resource { KeyValue k=v }, ScopeLogs { scope { name "lucid" }, LogRecord {} } }
        let want = [
            0x0a, 0x19, 0x0a, 0x0a, 0x0a, 0x08, 0x0a, 0x01, b'k', 0x12, 0x03, 0x0a, 0x01, b'v', 0x12, 0x0b, 0x0a, 0x07, 0x0a, 0x05, b'l', b'u', b'c', b'i', b'd', 0x12, 0x00,
        ];
        assert_eq!(got, want);
        assert!(logs_request(&res, "", &[json!({"severity": 3})]).is_err());
        assert!(traces_request(&res, "", &[json!({"name": "x"})]).is_err());
    }
}
