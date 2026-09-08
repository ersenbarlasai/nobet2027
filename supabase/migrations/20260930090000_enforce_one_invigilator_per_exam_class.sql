-- Sınıf bazlı yeni modelde her sınıf x gün x ders saati bir oturum ve bir
-- gözetmen görevidir. Sınıf bilgisi olmayan 20260929 öncesi tarihsel oturumlar
-- kendi kayıtlı sayılarını korur.

alter table public.exam_invigilation_sessions
  add constraint exam_invigilation_class_single_invigilator_ck
  check (school_class_id is null or required_invigilator_count = 1)
  not valid;

alter table public.exam_invigilation_sessions
  validate constraint exam_invigilation_class_single_invigilator_ck;
