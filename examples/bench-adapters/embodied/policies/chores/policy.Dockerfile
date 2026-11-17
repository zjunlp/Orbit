ARG POLICY_BASE
FROM ${POLICY_BASE}
ARG POLICY_FAMILY
COPY --from=clip / /opt/clip/
RUN pip install --no-cache-dir /opt/clip
COPY --from=allenact / /opt/allenact/
RUN if [ "$POLICY_FAMILY" = "flare" ]; then \
      pip install --no-cache-dir fire==0.7.1 && \
      pip install --no-deps --no-build-isolation /opt/allenact/allenact /opt/allenact/allenact_plugins; \
    fi
COPY --from=policy_source / /opt/chores-policy/
WORKDIR /opt/chores-policy
# Python 3.11 requires factories for nested dataclass defaults.
RUN sed -i -E '/^@dataclass$/i from dataclasses import field' \
      architecture/models/transformer_models/text_cond_visual_encoder.py \
      architecture/models/transformer_models/early_fusion_tsfm_models.py \
      architecture/models/transformer_models/early_fusion_gru_models.py && \
    sed -i -E 's/(fusion_xformer|visual_encoder|decoder)(: (TransformerConfig|TextCondVisualEncoderConfig|RNNConfig) = )(.+)$/\1\2field(default_factory=lambda: \4)/' \
      architecture/models/transformer_models/text_cond_visual_encoder.py \
      architecture/models/transformer_models/early_fusion_tsfm_models.py \
      architecture/models/transformer_models/early_fusion_gru_models.py
RUN python -c 'from pathlib import Path; import site; (Path(site.getsitepackages()[0]) / "chores.pth").write_text("/opt/chores-policy\n")'
RUN mkdir -p /opt/torch/hub/checkpoints
COPY --from=backbones / /opt/chores-backbones/
RUN if [ "$POLICY_FAMILY" = "flare" ]; then \
        sed -i 's@torch.hub.load("facebookresearch/dinov2", self.dino_model_type)@torch.hub.load("/opt/chores-backbones/dinov2", self.dino_model_type, source="local")@' \
          architecture/allenact_preprocessors/dino_preprocessors.py && \
        ln -s /opt/chores-backbones/dinov2_vits14_pretrain.pth /opt/torch/hub/checkpoints/dinov2_vits14_pretrain.pth; \
    fi
ENV PYTHONPATH=/opt/orbit-sdk TORCH_HOME=/opt/torch HF_HOME=/opt/chores-backbones/huggingface \
    HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 TOKENIZERS_PARALLELISM=false
COPY examples/sdk/orbit_embodied/*.py /opt/orbit-sdk/orbit_embodied/
COPY examples/bench-adapters/embodied/policies/chores/serve_chores.py examples/bench-adapters/embodied/policies/chores/release.json /opt/orbit/
RUN if [ "$POLICY_FAMILY" = "spoc" ]; then \
        python -c 'from architecture.models.transformer_models import REGISTERED_MODELS; from open_clip import get_tokenizer; assert "EarlyFusionCnnTransformer" in REGISTERED_MODELS; get_tokenizer("ViT-B-16-SigLIP-256")(["find the chair"])'; \
    else \
        python -c 'from training.online.dinov2_vits_tsfm_rgb_augment_objectnav import DinoV2ViTSTSFMObjectNav'; \
    fi
ENTRYPOINT ["python", "/opt/orbit/serve_chores.py"]
