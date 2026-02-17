import { FastifyPluginAsync } from 'fastify';
import { Static } from '@sinclair/typebox';
import { AuthenticatedRequest } from '../types';
import { LiteLLMService } from '../services/litellm.service';
import { ModelSyncService } from '../services/model-sync.service';
import { SubscriptionService } from '../services/subscription.service';
import {
  AdminCreateModelSchema,
  AdminUpdateModelSchema,
  AdminModelCreateResponseSchema,
  AdminModelUpdateResponseSchema,
  AdminModelDeleteResponseSchema,
  AdminModelParamsSchema,
  AdminModelErrorResponseSchema,
} from '../schemas/admin-models.js';

interface ModelRow {
  litellm_model_id: string;
}

const adminModelsRoutes: FastifyPluginAsync = async (fastify) => {
  // Initialize services
  const liteLLMService = new LiteLLMService(fastify);
  const modelSyncService = new ModelSyncService(fastify);
  const subscriptionService = new SubscriptionService(fastify);

  // Create a new model
  fastify.post<{
    Body: Static<typeof AdminCreateModelSchema>;
    Reply:
      | Static<typeof AdminModelCreateResponseSchema>
      | Static<typeof AdminModelErrorResponseSchema>;
  }>('/', {
    schema: {
      tags: ['Admin Models'],
      description: 'Create a new model in LiteLLM',
      security: [{ bearerAuth: [] }],
      body: AdminCreateModelSchema,
      response: {
        201: AdminModelCreateResponseSchema,
        400: AdminModelErrorResponseSchema,
        403: AdminModelErrorResponseSchema,
        500: AdminModelErrorResponseSchema,
      },
    },
    preHandler: [fastify.authenticate, fastify.requirePermission('admin:models')],
    handler: async (request, reply) => {
      const user = (request as AuthenticatedRequest).user;
      const {
        model_name,
        backend_model_name,
        description,
        api_base,
        api_key,
        input_cost_per_token,
        output_cost_per_token,
        tpm,
        rpm,
        max_tokens,
        supports_vision,
        supports_function_calling,
        supports_parallel_function_calling,
        supports_tool_choice,
        restrictedAccess,
      } = request.body;

      try {
        // Transform frontend payload to LiteLLM format
        const liteLLMPayload = {
          model_name,
          litellm_params: {
            model: `openai/${backend_model_name}`,
            api_base,
            custom_llm_provider: 'openai' as const,
            input_cost_per_token,
            output_cost_per_token,
            tpm,
            rpm,
            ...(api_key && { api_key }), // Only include api_key if provided
          },
          model_info: {
            db_model: true as const,
            max_tokens,
            supports_vision,
            supports_function_calling,
            supports_parallel_function_calling,
            supports_tool_choice,
          },
        };

        // Create model in LiteLLM
        const liteLLMResponse = await liteLLMService.createModel(liteLLMPayload);

        // Extract the LiteLLM model ID from the response
        const litellmModelId = liteLLMResponse?.model_info?.id || null;

        // Directly insert/update the local models table instead of relying on syncModels
        // This ensures the model is immediately available in the frontend
        try {
          const features = [];
          if (supports_function_calling) features.push('function_calling');
          if (supports_parallel_function_calling) features.push('parallel_function_calling');
          if (supports_tool_choice) features.push('tool_choice');
          if (supports_vision) features.push('vision');
          features.push('chat');

          await fastify.dbUtils.query(
            `INSERT INTO models (id, name, provider, description, category, context_length,
              input_cost_per_token, output_cost_per_token, supports_vision, supports_function_calling,
              supports_tool_choice, supports_parallel_function_calling, supports_streaming,
              features, availability, version, api_base, tpm, rpm, max_tokens,
              litellm_model_id, backend_model_name, restricted_access)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23)
            ON CONFLICT (id) DO UPDATE SET
              availability = 'available',
              litellm_model_id = COALESCE($21, models.litellm_model_id),
              description = COALESCE($4, models.description),
              backend_model_name = COALESCE($22, models.backend_model_name),
              restricted_access = COALESCE($23, models.restricted_access),
              input_cost_per_token = $7,
              output_cost_per_token = $8,
              api_base = $17,
              tpm = $18,
              rpm = $19,
              max_tokens = $20,
              updated_at = CURRENT_TIMESTAMP`,
            [
              model_name,                    // $1 id
              model_name,                    // $2 name
              'openai',                      // $3 provider
              description || null,           // $4 description
              'Language Model',              // $5 category
              max_tokens || null,            // $6 context_length
              input_cost_per_token || null,  // $7
              output_cost_per_token || null, // $8
              supports_vision || false,      // $9
              supports_function_calling || false, // $10
              supports_tool_choice || false, // $11
              supports_parallel_function_calling || false, // $12
              true,                          // $13 supports_streaming
              features,                      // $14
              'available',                   // $15 availability
              '1.0',                         // $16 version
              api_base || null,              // $17
              tpm || null,                   // $18
              rpm || null,                   // $19
              max_tokens || null,            // $20
              litellmModelId,                // $21
              backend_model_name || null,    // $22
              restrictedAccess !== undefined ? restrictedAccess : false, // $23
            ],
          );

          fastify.log.info(
            { model_name, litellmModelId },
            'Model directly inserted/updated in local database',
          );
        } catch (dbError) {
          fastify.log.warn({ dbError, model_name }, 'Failed to directly insert model - falling back to sync');
          // Fall back to sync approach
          try {
            await liteLLMService.clearCache('models:');
            await new Promise((resolve) => setTimeout(resolve, 2000));
            await modelSyncService.syncModels({ forceUpdate: true });
          } catch (syncError) {
            fastify.log.warn({ syncError }, 'Sync also failed after model creation');
          }
        }

        // Log admin action
        await fastify.dbUtils.query(
          `INSERT INTO audit_logs (user_id, action, resource_type, resource_id, metadata)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            user.userId,
            'MODEL_CREATE',
            'MODEL',
            model_name,
            JSON.stringify({
              model_name,
              description,
              api_base,
              input_cost_per_token,
              output_cost_per_token,
              tpm,
              rpm,
              max_tokens,
              supports_vision,
              supports_function_calling,
              supports_parallel_function_calling,
              supports_tool_choice,
              restrictedAccess,
              litellmModelId,
            }),
          ],
        );

        reply.status(201);
        return {
          success: true,
          message: `Model '${model_name}' created successfully`,
          model: {
            id: liteLLMResponse?.model_name || model_name,
            model_name,
            created_at: new Date().toISOString(),
          },
        };
      } catch (error: any) {
        fastify.log.error({ error, model_name }, 'Failed to create model');

        reply.status(500);
        return {
          error: 'CREATE_MODEL_FAILED',
          message: `Failed to create model '${model_name}'. Please check the configuration and try again.`,
          statusCode: 500,
        };
      }
    },
  });

  // Update an existing model
  fastify.put<{
    Params: Static<typeof AdminModelParamsSchema>;
    Body: Static<typeof AdminUpdateModelSchema>;
    Reply:
      | Static<typeof AdminModelUpdateResponseSchema>
      | Static<typeof AdminModelErrorResponseSchema>;
  }>('/:id', {
    schema: {
      tags: ['Admin Models'],
      description: 'Update an existing model in LiteLLM',
      security: [{ bearerAuth: [] }],
      params: AdminModelParamsSchema,
      body: AdminUpdateModelSchema,
      response: {
        200: AdminModelUpdateResponseSchema,
        400: AdminModelErrorResponseSchema,
        403: AdminModelErrorResponseSchema,
        404: AdminModelErrorResponseSchema,
        500: AdminModelErrorResponseSchema,
      },
    },
    preHandler: [fastify.authenticate, fastify.requirePermission('admin:models')],
    handler: async (request, reply) => {
      const user = (request as AuthenticatedRequest).user;
      const { id: modelId } = request.params;
      const updateData = request.body;

      try {
        // Transform frontend payload to LiteLLM format for update
        const liteLLMPayload: any = {};

        if (updateData.model_name) {
          liteLLMPayload.model_name = updateData.model_name;
        }

        if (
          Object.keys(updateData).some((key) =>
            [
              'backend_model_name',
              'api_base',
              'api_key',
              'input_cost_per_token',
              'output_cost_per_token',
              'tpm',
              'rpm',
            ].includes(key),
          )
        ) {
          liteLLMPayload.litellm_params = {};
          if (updateData.backend_model_name) {
            liteLLMPayload.litellm_params.model = `openai/${updateData.backend_model_name}`;
          } else if (updateData.model_name) {
            // Fallback to model_name for backward compatibility
            liteLLMPayload.litellm_params.model = `openai/${updateData.model_name}`;
          }
          if (updateData.api_base) {
            liteLLMPayload.litellm_params.api_base = updateData.api_base;
          }
          if (updateData.api_key) {
            liteLLMPayload.litellm_params.api_key = updateData.api_key;
          }
          if (updateData.input_cost_per_token !== undefined) {
            liteLLMPayload.litellm_params.input_cost_per_token = updateData.input_cost_per_token;
          }
          if (updateData.output_cost_per_token !== undefined) {
            liteLLMPayload.litellm_params.output_cost_per_token = updateData.output_cost_per_token;
          }
          if (updateData.tpm !== undefined) {
            liteLLMPayload.litellm_params.tpm = updateData.tpm;
          }
          if (updateData.rpm !== undefined) {
            liteLLMPayload.litellm_params.rpm = updateData.rpm;
          }
        }

        if (
          updateData.max_tokens !== undefined ||
          updateData.supports_vision !== undefined ||
          updateData.supports_function_calling !== undefined ||
          updateData.supports_parallel_function_calling !== undefined ||
          updateData.supports_tool_choice !== undefined
        ) {
          liteLLMPayload.model_info = {};
          if (updateData.max_tokens !== undefined) {
            liteLLMPayload.model_info.max_tokens = updateData.max_tokens;
          }
          if (updateData.supports_vision !== undefined) {
            liteLLMPayload.model_info.supports_vision = updateData.supports_vision;
          }
          if (updateData.supports_function_calling !== undefined) {
            liteLLMPayload.model_info.supports_function_calling =
              updateData.supports_function_calling;
          }
          if (updateData.supports_parallel_function_calling !== undefined) {
            liteLLMPayload.model_info.supports_parallel_function_calling =
              updateData.supports_parallel_function_calling;
          }
          if (updateData.supports_tool_choice !== undefined) {
            liteLLMPayload.model_info.supports_tool_choice = updateData.supports_tool_choice;
          }
        }

        // Get the LiteLLM model ID from the database
        const modelRecord = await fastify.dbUtils.queryOne<ModelRow>(
          `SELECT litellm_model_id FROM models WHERE id = $1`,
          [modelId],
        );

        if (!modelRecord || !modelRecord.litellm_model_id) {
          reply.status(400);
          return {
            error: 'INVALID_MODEL',
            message: `Model '${modelId}' not found or missing LiteLLM model ID`,
            statusCode: 400,
          };
        }

        // Update model in LiteLLM using the correct LiteLLM model ID
        await liteLLMService.updateModel(modelRecord.litellm_model_id, liteLLMPayload);

        // Log admin action
        await fastify.dbUtils.query(
          `INSERT INTO audit_logs (user_id, action, resource_type, resource_id, metadata)
           VALUES ($1, $2, $3, $4, $5)`,
          [user.userId, 'MODEL_UPDATE', 'MODEL', modelId, JSON.stringify({ modelId, updateData })],
        );

        // Clear cache and synchronize models after update
        try {
          await liteLLMService.clearCache('models:');
          await new Promise((resolve) => setTimeout(resolve, 2000));
          await modelSyncService.syncModels({ forceUpdate: true });

          // Update the description if provided by the user
          if (updateData.description !== undefined) {
            await fastify.dbUtils.query('UPDATE models SET description = $1 WHERE id = $2', [
              updateData.description,
              modelId,
            ]);
          }

          // Update the backend_model_name if provided by the user
          if (updateData.backend_model_name !== undefined) {
            await fastify.dbUtils.query('UPDATE models SET backend_model_name = $1 WHERE id = $2', [
              updateData.backend_model_name,
              modelId,
            ]);
          }

          // Handle restrictedAccess changes - triggers cascade logic
          if (updateData.restrictedAccess !== undefined) {
            // Get current restriction status
            const currentModel = await fastify.dbUtils.queryOne<{ restricted_access: boolean }>(
              'SELECT restricted_access FROM models WHERE id = $1',
              [modelId],
            );

            // Only trigger cascade if the value is actually changing
            if (currentModel && currentModel.restricted_access !== updateData.restrictedAccess) {
              // Update the database first
              await fastify.dbUtils.query(
                'UPDATE models SET restricted_access = $1 WHERE id = $2',
                [updateData.restrictedAccess, modelId],
              );

              // Then handle cascade logic (Phase 3 service method)
              // This will transition active subscriptions to pending and remove from API keys
              await subscriptionService.handleModelRestrictionChange(
                modelId,
                updateData.restrictedAccess,
              );

              fastify.log.info(
                { modelId, restrictedAccess: updateData.restrictedAccess },
                'Model restriction status updated with cascade',
              );
            } else if (
              currentModel &&
              currentModel.restricted_access === updateData.restrictedAccess
            ) {
              // No change, just log
              fastify.log.debug({ modelId }, 'Model restriction status unchanged');
            } else {
              // First-time setting (no current value)
              await fastify.dbUtils.query(
                'UPDATE models SET restricted_access = $1 WHERE id = $2',
                [updateData.restrictedAccess, modelId],
              );
            }
          }

          fastify.log.info('Model synchronization completed after model update');
        } catch (syncError) {
          fastify.log.warn({ syncError }, 'Model synchronization failed after model update');
        }

        return {
          success: true,
          message: `Model '${modelId}' updated successfully`,
          model: {
            id: modelId,
            model_name: updateData.model_name || modelId,
            updated_at: new Date().toISOString(),
          },
        };
      } catch (error: any) {
        fastify.log.error({ error, modelId, updateData }, 'Failed to update model');

        const statusCode = error.statusCode || 500;
        reply.status(statusCode);
        return {
          error: 'UPDATE_MODEL_FAILED',
          message: `Failed to update model '${modelId}'. Please check the configuration and try again.`,
          statusCode,
        };
      }
    },
  });

  // Delete a model
  fastify.delete<{
    Params: Static<typeof AdminModelParamsSchema>;
    Reply:
      | Static<typeof AdminModelDeleteResponseSchema>
      | Static<typeof AdminModelErrorResponseSchema>;
  }>('/:id', {
    schema: {
      tags: ['Admin Models'],
      description: 'Delete a model from LiteLLM',
      security: [{ bearerAuth: [] }],
      params: AdminModelParamsSchema,
      response: {
        200: AdminModelDeleteResponseSchema,
        403: AdminModelErrorResponseSchema,
        404: AdminModelErrorResponseSchema,
        500: AdminModelErrorResponseSchema,
      },
    },
    preHandler: [fastify.authenticate, fastify.requirePermission('admin:models')],
    handler: async (request, reply) => {
      const user = (request as AuthenticatedRequest).user;
      const { id: modelId } = request.params;

      try {
        // Get the LiteLLM model ID from the database
        const modelRecord = await fastify.dbUtils.queryOne<ModelRow>(
          `SELECT litellm_model_id FROM models WHERE id = $1`,
          [modelId],
        );

        if (!modelRecord || !modelRecord.litellm_model_id) {
          reply.status(400);
          return {
            error: 'INVALID_MODEL',
            message: `Model '${modelId}' not found or missing LiteLLM model ID`,
            statusCode: 400,
          };
        }

        // Delete model from LiteLLM using the correct LiteLLM model ID
        try {
          await liteLLMService.deleteModel(modelRecord.litellm_model_id);
          fastify.log.info({ modelId, litellmModelId: modelRecord.litellm_model_id }, 'Model deleted from LiteLLM');
        } catch (deleteError: any) {
          // If model is already gone from LiteLLM (404), proceed with local cleanup
          if (deleteError.statusCode === 404 || (deleteError.message && deleteError.message.includes('not found'))) {
            fastify.log.warn(
              { modelId, litellmModelId: modelRecord.litellm_model_id },
              'Model not found in LiteLLM (already deleted) - proceeding with local cleanup',
            );
          } else {
            throw deleteError;
          }
        }

        // Log admin action
        await fastify.dbUtils.query(
          `INSERT INTO audit_logs (user_id, action, resource_type, resource_id, metadata)
           VALUES ($1, $2, $3, $4, $5)`,
          [user.userId, 'MODEL_DELETE', 'MODEL', modelId, JSON.stringify({ modelId })],
        );

        // Cascade operations: deactivate subscriptions, remove API key associations
        try {
          const cascadeResult = await modelSyncService.markModelUnavailable(modelId);
          fastify.log.info(
            { modelId, cascadeResult },
            'Cascade operations completed (subscriptions deactivated, API key associations removed)',
          );
        } catch (dbError) {
          fastify.log.warn({ dbError, modelId }, 'Cascade operations failed - proceeding with delete');
        }

        // Delete the model row entirely from the local database.
        // This prevents syncModels from resurrecting the model if LiteLLM's
        // stale cache still returns it during the brief post-delete window.
        await fastify.dbUtils.query(`DELETE FROM models WHERE id = $1`, [modelId]);
        fastify.log.info({ modelId }, 'Model row deleted from local database');

        // Clear cache so subsequent reads are fresh
        await liteLLMService.clearCache('models:');

        return {
          success: true,
          message: `Model '${modelId}' deleted successfully`,
        };
      } catch (error: any) {
        fastify.log.error({ error, modelId }, 'Failed to delete model');

        const statusCode = error.statusCode || 500;
        reply.status(statusCode);
        return {
          error: 'DELETE_MODEL_FAILED',
          message: `Failed to delete model '${modelId}'. Please try again or contact an administrator.`,
          statusCode,
        };
      }
    },
  });
};

export default adminModelsRoutes;
