{{/* Pod template shared by the Deployment (Helm rollback mode) and the Rollout (canary mode). */}}
{{- define "releaseguard.podTemplate" -}}
metadata:
  labels: {app: {{ .Release.Name }}}
  annotations:
    prometheus.io/scrape: 'true'
    prometheus.io/port: {{ .Values.service.port | quote }}
    prometheus.io/path: /metrics
    {{- if .Values.progressiveDelivery.enabled }}
    # Init-container migrations and data-store clients bypass the sidecar: they run before
    # istio-proxy is ready, and PostgreSQL/Redis/Kafka are outside the mesh in this lab.
    traffic.sidecar.istio.io/excludeOutboundPorts: '5432,6379,9092'
    {{- end }}
spec:
  automountServiceAccountToken: false
  terminationGracePeriodSeconds: 30
  securityContext: {runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000, seccompProfile: {type: RuntimeDefault}}
  initContainers:
    - name: migrate
      image: '{{ .Values.image.repository }}:{{ .Values.image.tag }}'
      imagePullPolicy: {{ .Values.image.pullPolicy }}
      command: [node, dist/migrate.js]
      envFrom:
        - secretRef: {name: {{ .Values.app.secretName }}}
      securityContext: {allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: {drop: [ALL]}}
      resources: {{ .Values.resources | toJson }}
  containers:
    - name: api
      image: '{{ .Values.image.repository }}:{{ .Values.image.tag }}'
      imagePullPolicy: {{ .Values.image.pullPolicy }}
      ports: [{name: http, containerPort: {{ .Values.service.port }}}]
      envFrom:
        - secretRef: {name: {{ .Values.app.secretName }}}
      env:
        - {name: PORT, value: {{ .Values.service.port | quote }}}
        - {name: APP_VERSION, value: {{ .Values.app.version | quote }}}
        - {name: RELEASE_FAULT, value: {{ .Values.app.fault | quote }}}
      startupProbe: {httpGet: {path: /health/live, port: http}, periodSeconds: 2, failureThreshold: 30}
      readinessProbe: {httpGet: {path: /health/ready, port: http}, periodSeconds: 3, failureThreshold: 2}
      livenessProbe: {httpGet: {path: /health/live, port: http}, periodSeconds: 10, failureThreshold: 3}
      resources: {{ .Values.resources | toJson }}
      securityContext: {allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: {drop: [ALL]}}
{{- end -}}
