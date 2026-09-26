import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { ZohoApiError } from '../../zoho/zoho-api.error';

interface ErrorBody {
  statusCode: number;
  error: string;
  message: string | string[];
  path: string;
  timestamp: string;
}

/** Zoho codes that all mean "your token is no good". */
const AUTH_CODES = new Set([
  'INVALID_TOKEN',
  'AUTHENTICATION_FAILURE',
  'OAUTH_SCOPE_MISMATCH',
  'NOT_AUTHORIZED',
  'INVALID_CODE',
]);

@Catch()
export class ZohoExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<Request>();
    const res = ctx.getResponse<Response>();
    const timestamp = new Date().toISOString();
    const route = `${req.method} ${req.path}`;

    let body: ErrorBody;

    if (exception instanceof ZohoApiError) {
      body = {
        statusCode: exception.status,
        error: exception.zohoCode,
        message: this.friendlyZohoMessage(exception),
        path: req.path,
        timestamp,
      };
      // Only safe fields are logged — ZohoApiError never carries tokens or secrets.
      this.logger.error(
        JSON.stringify({
          timestamp,
          route,
          zohoEndpoint: exception.endpoint,
          zohoCode: exception.zohoCode,
          status: exception.status,
          message: exception.message,
          details: exception.details,
        }),
      );
    } else if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const response = exception.getResponse();
      const message =
        typeof response === 'object' &&
        response !== null &&
        'message' in response
          ? (response as { message: string | string[] }).message
          : exception.message;
      body = {
        statusCode: status,
        error: HttpStatus[status] ?? 'ERROR',
        message,
        path: req.path,
        timestamp,
      };
      if (status >= 500) {
        this.logger.error(
          JSON.stringify({ timestamp, route, status, message }),
        );
      } else {
        this.logger.warn(JSON.stringify({ timestamp, route, status, message }));
      }
    } else {
      body = {
        statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
        error: 'INTERNAL_SERVER_ERROR',
        message: 'Something went wrong. Please try again later.',
        path: req.path,
        timestamp,
      };
      const err = exception as Error;
      this.logger.error(
        JSON.stringify({ timestamp, route, message: err?.message }),
        err?.stack,
      );
    }

    res.status(body.statusCode).json(body);
  }

  /** Turn Zoho's terse codes into messages an API consumer can act on. */
  private friendlyZohoMessage(err: ZohoApiError): string {
    const field = (err.details?.api_name as string | undefined) ?? undefined;

    if (AUTH_CODES.has(err.zohoCode)) {
      return err.zohoCode === 'NOT_AUTHORIZED' ||
        err.zohoCode === 'INVALID_CODE'
        ? err.message
        : 'Zoho access token is invalid or expired and could not be refreshed. Visit /oauth/login to reconnect.';
    }

    switch (err.zohoCode) {
      case 'INVALID_MODULE':
        return 'The requested Zoho CRM module does not exist or is not supported.';
      case 'MANDATORY_NOT_FOUND':
        return field
          ? `Required field "${field}" is missing.`
          : 'A required field is missing.';
      case 'INVALID_DATA':
        return field
          ? `Invalid value for field "${field}".`
          : 'Zoho rejected the request because some data is invalid (check the record ID or field values).';
      case 'DUPLICATE_DATA':
        return 'A record with the same unique value already exists in Zoho CRM.';
      case 'INVALID_URL_PATTERN':
        return 'The requested Zoho resource URL is invalid.';
      case 'LIMIT_EXCEEDED':
      case 'TOO_MANY_REQUESTS':
        return 'Zoho API rate limit reached. Please retry shortly.';
      default:
        return err.message;
    }
  }
}
