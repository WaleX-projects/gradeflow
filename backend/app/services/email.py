import smtplib
from email.message import EmailMessage

from app.core.config import settings


def mail_ready() -> bool:
    return bool(settings.smtp_host and settings.email_from and settings.frontend_origin)


def send_account_email(recipient: str, subject: str, path: str) -> bool:
    if not settings.smtp_host or not settings.email_from or not settings.frontend_origin:
        return False
    origin = (settings.frontend_origin or "").rstrip("/")
    url = f"{origin}{path}" if origin else path
    message = EmailMessage()
    message["Subject"] = subject
    message["From"] = settings.email_from
    message["To"] = recipient
    message.set_content(
        f"{subject}\n\nContinue securely using this one-time link:\n{url}\n\nIf you did not request this, you can ignore this message."
    )
    try:
        with smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=10) as server:
            server.starttls()
            if settings.smtp_user:
                server.login(settings.smtp_user, settings.smtp_password_value or "")
            server.send_message(message)
        return True
    except (OSError, smtplib.SMTPException):
        return False
