{{/*
Naming helpers — every named resource in the chart funnels through these.
Two releases in the same namespace stay disjoint because every object
name embeds `.Release.Name`.

`fullname` follows the standard Helm convention (truncated at 63 chars,
trailing '-' stripped) so DNS-1123 rules hold.
*/}}

{{- define "foyer-studio.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "foyer-studio.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "foyer-studio.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "foyer-studio.labels" -}}
helm.sh/chart: {{ include "foyer-studio.chart" . }}
{{ include "foyer-studio.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: foyer-studio
{{- end -}}

{{- define "foyer-studio.selectorLabels" -}}
app.kubernetes.io/name: {{ include "foyer-studio.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{/*
ServiceAccount name — `foo-sa` if `serviceAccount.name` is set, otherwise
the fullname.
*/}}
{{- define "foyer-studio.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{ default (include "foyer-studio.fullname" .) .Values.serviceAccount.name }}
{{- else -}}
{{ default "default" .Values.serviceAccount.name }}
{{- end -}}
{{- end -}}

{{/*
Resolved image reference — `tag` falls back to `.Chart.AppVersion`.
*/}}
{{- define "foyer-studio.image" -}}
{{- $tag := .Values.image.tag | default .Chart.AppVersion -}}
{{- printf "%s:%s" .Values.image.repository $tag -}}
{{- end -}}

{{/*
Effective config Secret name — either the chart's rendered Secret or
the user-supplied existing one.
*/}}
{{- define "foyer-studio.configSecretName" -}}
{{- if and (not .Values.config.create) .Values.config.existingSecret -}}
{{ .Values.config.existingSecret }}
{{- else -}}
{{ include "foyer-studio.fullname" . }}-config
{{- end -}}
{{- end -}}

{{/*
Effective projects PVC name.
*/}}
{{- define "foyer-studio.projectsPvcName" -}}
{{- if .Values.persistence.projects.existingClaim -}}
{{ .Values.persistence.projects.existingClaim }}
{{- else -}}
{{ include "foyer-studio.fullname" . }}-projects
{{- end -}}
{{- end -}}

{{/*
Mutual-exclusion guard for expose modes. Helm chokes on `fail` only at
template render time, which is exactly when we want to surface this.
*/}}
{{- define "foyer-studio.assertExpose" -}}
{{- if and .Values.expose.ingress.enabled .Values.expose.gateway.enabled -}}
{{- fail "expose.ingress.enabled and expose.gateway.enabled are mutually exclusive — pick one" -}}
{{- end -}}
{{- if and .Values.webOverlay.enabled (eq .Values.webOverlay.kind "none") -}}
{{- fail "webOverlay.enabled is true but webOverlay.kind is 'none' — set kind to pvc | image | imageVolume" -}}
{{- end -}}
{{- end -}}
