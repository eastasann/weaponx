# インフラ作業用: gcloud + Terraform + openssl
FROM google/cloud-sdk:slim

ARG TERRAFORM_VERSION=1.13.3

# 通信を検査するネットワーク用。証明書は BuildKit の secret で渡し、最後に取り除いて
# システムの証明書の束を作り直す(イメージには残さない。03 3章 EXTRA_CA_CERT)
RUN --mount=type=secret,id=extra_ca,required=false \
    if [ -s /run/secrets/extra_ca ]; then \
      cp /run/secrets/extra_ca /usr/local/share/ca-certificates/extra-ca.crt && update-ca-certificates; \
    fi; \
    apt-get update && apt-get install -y --no-install-recommends unzip openssl ca-certificates \
    && arch="$(dpkg --print-architecture)" \
    && base="https://releases.hashicorp.com/terraform/${TERRAFORM_VERSION}" \
    && cd /tmp \
    && curl -fsSLO "${base}/terraform_${TERRAFORM_VERSION}_linux_${arch}.zip" \
    && curl -fsSLO "${base}/terraform_${TERRAFORM_VERSION}_SHA256SUMS" \
    && grep "terraform_${TERRAFORM_VERSION}_linux_${arch}.zip" "terraform_${TERRAFORM_VERSION}_SHA256SUMS" | sha256sum -c - \
    && unzip "terraform_${TERRAFORM_VERSION}_linux_${arch}.zip" -d /usr/local/bin \
    && rm -f /tmp/terraform_* \
    && rm -rf /var/lib/apt/lists/* \
    && rm -f /usr/local/share/ca-certificates/extra-ca.crt && update-ca-certificates --fresh

WORKDIR /workspace
