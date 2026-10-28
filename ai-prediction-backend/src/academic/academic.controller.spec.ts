import { AcademicController } from './academic.controller';

describe('AcademicController course catalog', () => {
  it('returns database rows with the standard paginated envelope', async () => {
    const course = { id: 'course-uuid', code: 'BIO101' };
    const prisma = {
      $transaction: jest.fn(async ([rows, count]: [Promise<unknown>, Promise<number>]) => Promise.all([rows, count])),
      course: {
        findMany: jest.fn().mockResolvedValue([course]),
        count: jest.fn().mockResolvedValue(1),
      },
    };
    const controller = new AcademicController(prisma as never);

    await expect(controller.courseCatalog({ id: 'admin-user', role: 'ADMIN' } as never, '1', '20')).resolves.toEqual({
      data: [course],
      meta: { page: 1, pageSize: 20, total: 1, totalPages: 1 },
    });
    expect(prisma.course.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 0, take: 20 }));
  });

  it('scopes a teacher catalog to courses in assigned offerings', async () => {
    const prisma = {
      $transaction: jest.fn(async ([rows]: [Promise<unknown>, Promise<number>]) => Promise.all([rows, Promise.resolve(0)])),
      course: { findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) },
    };
    const controller = new AcademicController(prisma as never);

    await controller.courseCatalog({ id: 'teacher-user', role: 'TEACHER' } as never, undefined, undefined, 'department-uuid');

    expect(prisma.course.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { departmentId: 'department-uuid', offerings: { some: { teacher: { userId: 'teacher-user' } } } },
    }));
  });
});
